'use strict';

/**
 * A small, dependency-free multicast DNS responder.
 *
 * It answers A queries for the hostnames this proxy owns (openwebui.local,
 * plex.local, ...) with the proxy's own LAN address, so that every client on
 * the network resolves those names to us and we can route by Host header.
 *
 * Only the subset of RFC 6762 needed for name resolution is implemented:
 * A answers, NSEC "no AAAA here" hints, unsolicited announcements, and
 * goodbye packets. Probing/conflict resolution is deliberately omitted.
 */

const dgram = require('dgram');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_NSEC = 47;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const FLUSH = 0x8000;
const TTL = 120;
const LEGACY_TTL = 10;

// --- wire format ------------------------------------------------------------

function encodeName(name) {
  const labels = String(name).replace(/\.$/, '').split('.');
  const parts = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8');
    if (buf.length > 63) throw new Error(`Label too long: ${label}`);
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeName(msg, offset) {
  const labels = [];
  let jumped = false;
  let cursor = offset;
  let next = offset;
  let hops = 0;

  for (;;) {
    if (cursor >= msg.length) throw new Error('Truncated name');
    const len = msg[cursor];
    if (len === 0) {
      cursor += 1;
      if (!jumped) next = cursor;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (cursor + 1 >= msg.length) throw new Error('Truncated pointer');
      if (++hops > 16) throw new Error('Name compression loop');
      const pointer = ((len & 0x3f) << 8) | msg[cursor + 1];
      if (!jumped) next = cursor + 2;
      jumped = true;
      cursor = pointer;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('Bad label length');
    cursor += 1;
    if (cursor + len > msg.length) throw new Error('Truncated label');
    labels.push(msg.toString('utf8', cursor, cursor + len));
    cursor += len;
  }
  return { name: labels.join('.'), offset: next };
}

function parseQuery(msg) {
  if (msg.length < 12) return null;
  const flags = msg.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a question for us
  const id = msg.readUInt16BE(0);
  const qdcount = msg.readUInt16BE(4);

  const questions = [];
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    const decoded = decodeName(msg, offset);
    offset = decoded.offset;
    if (offset + 4 > msg.length) throw new Error('Truncated question');
    const type = msg.readUInt16BE(offset);
    const rawClass = msg.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({
      name: decoded.name,
      type,
      class: rawClass & 0x7fff,
      unicastResponse: Boolean(rawClass & 0x8000),
    });
  }
  return { id, questions };
}

function aRecord(name, ip, ttl) {
  const nameBuf = encodeName(name);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(TYPE_A, 0);
  head.writeUInt16BE(CLASS_IN | FLUSH, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(4, 8);
  const rdata = Buffer.from(ip.split('.').map((n) => Number(n) & 0xff));
  return Buffer.concat([nameBuf, head, rdata]);
}

/** Tells the querier "this name has an A record and nothing else" so clients
 *  stop waiting on the AAAA lookup. */
function nsecRecord(name, ttl) {
  const nameBuf = encodeName(name);
  // Bitmap window 0, one byte long, bit 1 (A) set.
  const rdata = Buffer.concat([encodeName(name), Buffer.from([0x00, 0x01, 0x40])]);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(TYPE_NSEC, 0);
  head.writeUInt16BE(CLASS_IN | FLUSH, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, head, rdata]);
}

function buildResponse({ id = 0, answers = [], additionals = [], questions = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2); // QR + Authoritative Answer
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);

  const qbufs = questions.map((q) => {
    const n = encodeName(q.name);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(q.class, 2);
    return Buffer.concat([n, tail]);
  });

  return Buffer.concat([header, ...qbufs, ...answers, ...additionals]);
}

// --- responder --------------------------------------------------------------

class MdnsResponder {
  constructor({ logger = console } = {}) {
    this.log = logger;
    this.socket = null;
    this.names = [];
    this.ip = null;
    this.running = false;
    this.timers = [];
    this.refresh = null;
  }

  /** @param {string[]} names fully-qualified names, e.g. ["openwebui.local"] */
  setRecords(names, ip) {
    const unique = [...new Set(names.map((n) => String(n).toLowerCase()))].sort();
    const changed = unique.join(',') !== this.names.join(',') || ip !== this.ip;
    this.names = unique;
    this.ip = ip;
    if (changed && this.running) this.announce();
    return changed;
  }

  start(interfaces = []) {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.log.error(
          '[mdns] Port 5353 is already in use. Another mDNS responder (usually avahi) '
          + 'owns it on this host. Run this container on its own IP (macvlan/br0) or stop the '
          + 'other responder. The proxy itself keeps working; .local names will not resolve.',
        );
      } else {
        this.log.error(`[mdns] socket error: ${err.message}`);
      }
      this.stop();
    });

    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));

    socket.bind(MDNS_PORT, () => {
      try {
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
      } catch (err) {
        this.log.warn(`[mdns] could not set multicast options: ${err.message}`);
      }
      let joined = 0;
      for (const addr of interfaces) {
        try {
          socket.addMembership(MDNS_ADDR, addr);
          joined += 1;
        } catch (err) {
          this.log.warn(`[mdns] could not join multicast group on ${addr}: ${err.message}`);
        }
      }
      if (!joined) {
        try {
          socket.addMembership(MDNS_ADDR);
          joined = 1;
        } catch (err) {
          this.log.error(`[mdns] failed to join ${MDNS_ADDR}: ${err.message}`);
        }
      }
      if (this.ip) {
        try {
          socket.setMulticastInterface(this.ip);
        } catch {
          /* multi-homed edge case; default interface will do */
        }
      }
      this.running = true;
      this.log.info(`[mdns] responder listening on ${MDNS_ADDR}:${MDNS_PORT}, advertising ${this.ip}`);
      // RFC 6762 asks for at least two announcements a second apart.
      this.timers.push(setTimeout(() => this.announce(), 400));
      this.timers.push(setTimeout(() => this.announce(), 1500));
      this.timers.push(setTimeout(() => this.announce(), 4000));
      this.refresh = setInterval(() => this.announce(), 60_000);
      if (this.refresh.unref) this.refresh.unref();
    });
  }

  onMessage(msg, rinfo) {
    if (!this.running || !this.ip || this.names.length === 0) return;
    let query;
    try {
      query = parseQuery(msg);
    } catch {
      return; // malformed packet from somewhere on the LAN; ignore it
    }
    if (!query || query.questions.length === 0) return;

    const legacy = rinfo.port !== MDNS_PORT;
    const ttl = legacy ? LEGACY_TTL : TTL;
    const answers = [];
    const additionals = [];
    const matched = [];
    let unicast = legacy;

    for (const q of query.questions) {
      if (q.class !== CLASS_IN && q.class !== TYPE_ANY) continue;
      const name = q.name.toLowerCase();
      if (!this.names.includes(name)) continue;
      if (q.type === TYPE_A || q.type === TYPE_ANY) {
        answers.push(aRecord(name, this.ip, ttl));
        additionals.push(nsecRecord(name, ttl));
        matched.push(q);
        if (q.unicastResponse) unicast = true;
      } else {
        // We own the name but hold no record of that type (e.g. AAAA).
        additionals.push(nsecRecord(name, ttl));
      }
    }

    if (answers.length === 0) return;

    const packet = buildResponse({
      id: legacy ? query.id : 0,
      questions: legacy ? matched : [],
      answers,
      additionals,
    });

    if (unicast) {
      this.send(packet, rinfo.port, rinfo.address);
    } else {
      // Spread replies out slightly so simultaneous responders don't collide.
      const delay = 20 + Math.floor(Math.random() * 100);
      const t = setTimeout(() => this.send(packet, MDNS_PORT, MDNS_ADDR), delay);
      if (t.unref) t.unref();
    }
  }

  announce(ttl = TTL) {
    if (!this.socket || !this.ip || this.names.length === 0) return;
    const answers = this.names.map((n) => aRecord(n, this.ip, ttl));
    const additionals = ttl > 0 ? this.names.map((n) => nsecRecord(n, ttl)) : [];
    this.send(buildResponse({ answers, additionals }), MDNS_PORT, MDNS_ADDR);
  }

  send(packet, port, address) {
    if (!this.socket) return;
    this.socket.send(packet, 0, packet.length, port, address, (err) => {
      if (err) this.log.warn(`[mdns] send failed: ${err.message}`);
    });
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
    if (this.socket) {
      if (this.running) {
        try { this.announce(0); } catch { /* going away anyway */ }
      }
      const socket = this.socket;
      this.socket = null;
      this.running = false;
      setTimeout(() => { try { socket.close(); } catch { /* already closed */ } }, 60);
    }
    this.running = false;
  }
}

module.exports = {
  MdnsResponder,
  // exported for tests
  encodeName,
  decodeName,
  parseQuery,
  buildResponse,
  aRecord,
  MDNS_ADDR,
  MDNS_PORT,
};

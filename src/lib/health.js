'use strict';

const net = require('net');

const PROBE_TIMEOUT_MS = 3000;

/** Opens a TCP connection just far enough to prove something is listening. */
function probe(host, port, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish({ up: true, latencyMs: Date.now() - started }));
    socket.once('timeout', () => finish({ up: false, error: 'timeout' }));
    socket.once('error', (err) => finish({ up: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

class HealthMonitor {
  constructor(getServices, { intervalSeconds = 30, logger = console } = {}) {
    this.getServices = getServices;
    this.intervalSeconds = intervalSeconds;
    this.log = logger;
    this.state = new Map();
    this.timer = null;
    this.running = false;
  }

  start() {
    this.stop();
    const ms = Math.max(5, Number(this.intervalSeconds) || 30) * 1000;
    this.timer = setInterval(() => this.runOnce(), ms);
    if (this.timer.unref) this.timer.unref();
    this.runOnce();
  }

  setInterval(seconds) {
    this.intervalSeconds = seconds;
    if (this.timer) this.start();
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const services = this.getServices().filter((s) => s.enabled);
      const live = new Set(services.map((s) => s.id));
      for (const id of this.state.keys()) {
        if (!live.has(id)) this.state.delete(id);
      }
      await Promise.all(services.map(async (service) => {
        const result = await probe(service.host, service.port);
        this.state.set(service.id, {
          up: result.up,
          latencyMs: result.latencyMs ?? null,
          error: result.error ?? null,
          checkedAt: new Date().toISOString(),
        });
      }));
    } catch (err) {
      this.log.warn(`[health] check failed: ${err.message}`);
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    return Object.fromEntries(this.state);
  }

  get(id) {
    return this.state.get(id) || null;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * On Unraid, br0 is an ipvlan network, and an ipvlan container cannot reach its
 * own host — so every service published on the host is invisible to it until a
 * second network is attached. That failure looks like "everything is offline",
 * which sends people hunting in the wrong place. Detect it explicitly.
 */
async function diagnoseHostReachability(services) {
  const viaHost = services.filter((s) => /^172\.(1[6-9]|2\d|3[01])\.\d+\.1$/.test(s.host)
    || /^(10|192)\./.test(s.host));
  if (!viaHost.length) return { checked: 0, blocked: false };

  const sample = viaHost.slice(0, 6);
  const results = await Promise.all(sample.map((s) => probe(s.host, s.port, 2000)));
  const reachable = results.filter((r) => r.up).length;

  return {
    checked: sample.length,
    reachable,
    // Nothing at all answering, across several different targets, is the signature.
    blocked: sample.length >= 3 && reachable === 0,
  };
}

module.exports = { HealthMonitor, probe, diagnoseHostReachability };

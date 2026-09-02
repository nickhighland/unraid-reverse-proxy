'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the config module at a throwaway directory before loading anything.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'urp-test-'));

const mdns = require('../src/lib/mdns');
const config = require('../src/lib/config');
const proxy = require('../src/lib/proxy');

// --------------------------------------------------------------------------
test('mDNS: encodes and decodes names', () => {
  const encoded = mdns.encodeName('openwebui.local');
  assert.equal(encoded[0], 9, 'first label length');
  assert.equal(encoded[encoded.length - 1], 0, 'root terminator');
  assert.equal(mdns.decodeName(encoded, 0).name, 'openwebui.local');
});

test('mDNS: parses a standard A query', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // A
  tail.writeUInt16BE(1, 2); // IN
  const query = Buffer.concat([header, mdns.encodeName('plex.local'), tail]);

  const parsed = mdns.parseQuery(query);
  assert.equal(parsed.questions.length, 1);
  assert.deepEqual(parsed.questions[0], {
    name: 'plex.local', type: 1, class: 1, unicastResponse: false,
  });
});

test('mDNS: reads the unicast-response (QU) bit', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0);
  tail.writeUInt16BE(0x8001, 2); // QU bit + IN
  const query = Buffer.concat([header, mdns.encodeName('a.local'), tail]);
  assert.equal(mdns.parseQuery(query).questions[0].unicastResponse, true);
});

test('mDNS: ignores responses rather than answering them', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // QR set => this is a response
  assert.equal(mdns.parseQuery(header), null);
});

test('mDNS: refuses to loop on a self-referential compression pointer', () => {
  const evil = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 0x0c])]);
  assert.throws(() => mdns.decodeName(evil, 12), /loop/i);
});

test('mDNS: builds an authoritative A answer with the cache-flush bit', () => {
  const packet = mdns.buildResponse({ answers: [mdns.aRecord('plex.local', '192.168.1.7', 120)] });
  assert.equal(packet.readUInt16BE(0), 0, 'multicast responses use ID 0');
  assert.equal(packet.readUInt16BE(2), 0x8400, 'QR + AA');
  assert.equal(packet.readUInt16BE(6), 1, 'one answer');

  const { offset } = mdns.decodeName(packet, 12);
  assert.equal(packet.readUInt16BE(offset), 1, 'type A');
  assert.equal(packet.readUInt16BE(offset + 2), 0x8001, 'cache-flush + IN');
  assert.equal(packet.readUInt32BE(offset + 4), 120, 'ttl');
  assert.deepEqual([...packet.subarray(offset + 10, offset + 14)], [192, 168, 1, 7]);
});

// --------------------------------------------------------------------------
test('config: accepts a plain hostname', () => {
  const result = config.validateService({
    name: 'Open WebUI', hostname: 'openwebui', host: '192.168.254.254', port: 8080,
  });
  assert.ok(result.ok, result.error);
  assert.equal(result.service.hostname, 'openwebui');
  assert.equal(result.service.port, 8080);
});

test('config: strips a typed .local suffix and lowercases', () => {
  const result = config.validateService({
    name: 'Plex', hostname: 'Plex.local', host: '10.0.0.5', port: 32400,
  });
  assert.ok(result.ok, result.error);
  assert.equal(result.service.hostname, 'plex');
});

test('config: splits host:port pasted into the address field', () => {
  const result = config.validateService({
    name: 'Sonarr', hostname: 'sonarr', host: '192.168.1.9:8989',
  });
  assert.ok(result.ok, result.error);
  assert.equal(result.service.host, '192.168.1.9');
  assert.equal(result.service.port, 8989);
});

test('config: strips a scheme pasted into the address field', () => {
  const result = config.validateService({
    name: 'Radarr', hostname: 'radarr', host: 'http://192.168.1.9/', port: 7878,
  });
  assert.ok(result.ok, result.error);
  assert.equal(result.service.host, '192.168.1.9');
});

test('config: rejects malformed hostnames', () => {
  for (const bad of ['-nope', 'nope-', 'has space', 'under_score', '']) {
    const result = config.validateService({ name: 'x', hostname: bad, host: '1.2.3.4', port: 80 });
    assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
  }
});

test('config: rejects out-of-range ports', () => {
  for (const bad of [0, 65536, -1, 1.5]) {
    const result = config.validateService({ name: 'x', hostname: 'ok', host: '1.2.3.4', port: bad });
    assert.equal(result.ok, false, `expected port ${bad} to be rejected`);
  }
});

test('config: refuses to shadow the admin hostname', () => {
  const cfg = config.load();
  const result = config.validateService({
    name: 'Evil', hostname: cfg.settings.adminHostname, host: '1.2.3.4', port: 80,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /reserved/i);
});

test('config: rejects a duplicate hostname but lets an edit keep its own', () => {
  const cfg = config.load();
  const first = config.validateService({ name: 'A', hostname: 'dupe', host: '1.2.3.4', port: 80 });
  cfg.services.push(first.service);

  const clash = config.validateService({ name: 'B', hostname: 'dupe', host: '5.6.7.8', port: 81 });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already used/i);

  const selfEdit = config.validateService(
    { name: 'A renamed', hostname: 'dupe', host: '1.2.3.4', port: 90 },
    first.service.id,
  );
  assert.ok(selfEdit.ok, selfEdit.error);
  cfg.services.length = 0;
});

// --------------------------------------------------------------------------
test('proxy: drops hop-by-hop headers and anything Connection names', () => {
  const filtered = proxy.filterHeaders({
    host: 'openwebui.local',
    connection: 'keep-alive, X-Private',
    'x-private': 'secret',
    'transfer-encoding': 'chunked',
    upgrade: 'h2c',
    'x-keep': 'yes',
  });
  assert.deepEqual(Object.keys(filtered).sort(), ['host', 'x-keep']);
});

test('proxy: rewrites redirects that point back at the upstream origin', () => {
  const service = { scheme: 'http', host: '192.168.1.50', port: 8080, rewriteRedirects: true };
  const req = { headers: { host: 'openwebui.local' } };
  assert.equal(
    proxy.rewriteLocation('http://192.168.1.50:8080/login', req, service, 80),
    'http://openwebui.local/login',
  );
});

test('proxy: leaves external redirects alone', () => {
  const service = { scheme: 'http', host: '192.168.1.50', port: 8080, rewriteRedirects: true };
  const req = { headers: { host: 'openwebui.local' } };
  const external = 'https://accounts.google.com/o/oauth2/auth?x=1';
  assert.equal(proxy.rewriteLocation(external, req, service, 80), external);
});

test('proxy: leaves relative redirects alone', () => {
  const service = { scheme: 'http', host: '192.168.1.50', port: 8080, rewriteRedirects: true };
  const req = { headers: { host: 'openwebui.local' } };
  assert.equal(proxy.rewriteLocation('/dashboard', req, service, 80), '/dashboard');
});

test('proxy: honours the per-service rewrite toggle', () => {
  const service = { scheme: 'http', host: '192.168.1.50', port: 8080, rewriteRedirects: false };
  const req = { headers: { host: 'openwebui.local' } };
  const location = 'http://192.168.1.50:8080/login';
  assert.equal(proxy.rewriteLocation(location, req, service, 80), location);
});

test.after(() => {
  fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true });
});

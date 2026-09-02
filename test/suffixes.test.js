'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Seed a v1-shaped config so the migration path is exercised on first load.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urp-suffix-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  version: 1,
  settings: { domainSuffix: 'home', adminHostname: 'proxy', httpPort: 80 },
  services: [{ name: 'Plex', hostname: 'plex', host: '10.0.0.5', port: 32400 }],
}));
process.env.CONFIG_DIR = dir;

const suffixes = require('../src/lib/suffixes');
const config = require('../src/lib/config');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// --- migration -------------------------------------------------------------

test('a v1 single domainSuffix is migrated into the list', () => {
  const cfg = config.load();
  assert.deepEqual(cfg.settings.domainSuffixes, ['home']);
  assert.equal(cfg.settings.domainSuffix, undefined, 'the legacy key is dropped');
  assert.equal(config.primarySuffix(cfg), 'home');
});

test('a config with no suffix at all falls back to local', () => {
  const cfg = config.load();
  const saved = cfg.settings.domainSuffixes;
  cfg.settings.domainSuffixes = [];
  assert.deepEqual(config.suffixes(cfg), ['local']);
  cfg.settings.domainSuffixes = saved;
});

// --- naming ----------------------------------------------------------------

test('a service answers on every configured suffix', () => {
  const cfg = config.load();
  cfg.settings.domainSuffixes = ['local', 'home.arpa', 'lan'];
  const service = cfg.services[0];
  assert.deepEqual(config.allFqdns(service, cfg), ['plex.local', 'plex.home.arpa', 'plex.lan']);
  assert.equal(config.fqdn(service, cfg), 'plex.local', 'display name uses the primary suffix');
});

test('urls are built for every suffix and respect a non-80 port', () => {
  const cfg = config.load();
  cfg.settings.domainSuffixes = ['local', 'lan'];
  cfg.settings.httpPort = 8088;
  assert.deepEqual(config.publicUrls(cfg.services[0], cfg), [
    'http://plex.local:8088/', 'http://plex.lan:8088/',
  ]);
  cfg.settings.httpPort = 80;
  assert.deepEqual(config.publicUrls(cfg.services[0], cfg), [
    'http://plex.local/', 'http://plex.lan/',
  ]);
});

test('stripSuffix removes whichever suffix matched', () => {
  const cfg = config.load();
  cfg.settings.domainSuffixes = ['local', 'home.arpa'];
  assert.equal(config.stripSuffix('plex.local', cfg), 'plex');
  assert.equal(config.stripSuffix('plex.home.arpa', cfg), 'plex');
  assert.equal(config.stripSuffix('plex.home.arpa.', cfg), 'plex', 'trailing dot tolerated');
  assert.equal(config.stripSuffix('plex', cfg), 'plex', 'bare label passes through');
  assert.equal(config.stripSuffix('plex.example.com', cfg), 'plex.example.com', 'unknown suffix untouched');
});

test('hasKnownSuffix only matches configured suffixes', () => {
  const cfg = config.load();
  cfg.settings.domainSuffixes = ['local', 'lan'];
  assert.equal(config.hasKnownSuffix('plex.local', cfg), true);
  assert.equal(config.hasKnownSuffix('plex.lan', cfg), true);
  assert.equal(config.hasKnownSuffix('plex.home', cfg), false);
  assert.equal(config.hasKnownSuffix('192.168.1.5', cfg), false);
});

test('a hostname typed with any configured suffix is stored as a bare label', () => {
  const cfg = config.load();
  cfg.settings.domainSuffixes = ['local', 'home.arpa'];
  for (const typed of ['sonarr', 'sonarr.local', 'Sonarr.HOME.ARPA', 'sonarr.local.']) {
    const result = config.validateService({ name: 'S', hostname: typed, host: '1.2.3.4', port: 80 });
    assert.ok(result.ok, `${typed}: ${result.error}`);
    assert.equal(result.service.hostname, 'sonarr', `${typed} should reduce to "sonarr"`);
  }
});

// --- guidance --------------------------------------------------------------

test('only .local is reported as self-resolving', () => {
  assert.equal(suffixes.describe('local').resolves, 'mdns');
  for (const other of ['home.arpa', 'internal', 'lan', 'home', 'whatever']) {
    assert.equal(suffixes.describe(other).resolves, 'dns', `${other} needs DNS`);
  }
});

test('HSTS-preloaded TLDs are flagged, because plain HTTP cannot work there', () => {
  for (const tld of ['dev', 'app', 'zip', 'mov', 'page']) {
    const info = suffixes.describe(tld);
    assert.match(info.warning || '', /HSTS/, `.${tld} should warn about forced HTTPS`);
  }
  assert.match(suffixes.describe('my.dev').warning || '', /HSTS/, 'checks the final label');
});

test('reserved private suffixes carry no warning', () => {
  for (const safe of ['local', 'home.arpa', 'internal', 'lan', 'home']) {
    assert.equal(suffixes.describe(safe).warning, null, `${safe} should not warn`);
  }
});

test('an unreserved invented suffix warns about future collisions', () => {
  assert.match(suffixes.describe('nickstuff').warning || '', /not a reserved/i);
});

test('suffix validation normalises and rejects junk', () => {
  assert.deepEqual(suffixes.validate('.Local.'), { ok: true, suffix: 'local' });
  assert.deepEqual(suffixes.validate('  HOME.ARPA '), { ok: true, suffix: 'home.arpa' });
  for (const bad of ['', '   ', 'has space', 'under_score', '-lead', 'trail-', 'a..b']) {
    assert.equal(suffixes.validate(bad).ok, false, `expected "${bad}" to be rejected`);
  }
});

test('the suffix list dedupes and enforces bounds', () => {
  assert.deepEqual(
    suffixes.validateList(['local', 'LOCAL', '.local.', 'lan']).suffixes,
    ['local', 'lan'],
  );
  assert.equal(suffixes.validateList([]).ok, false);
  assert.equal(suffixes.validateList(['a', 'b', 'c', 'd', 'e', 'f', 'g']).ok, false);
  assert.equal(suffixes.validateList(['local', 'bad suffix']).ok, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROXY_PORT = 18088;
const UPSTREAM_PORT = 19101;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

let server;
let upstream;
let configDir;
let cookie = '';

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urp-int-'));

  upstream = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${UPSTREAM_PORT}/after` });
      return res.end();
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const received = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        url: req.url, method: req.method, headers: req.headers, received,
      }));
    });
  });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nWS-OK');
  });
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      CONFIG_DIR: configDir,
      HTTP_PORT: String(PROXY_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('error', reject);
  });
});

test.after(async () => {
  if (server) server.kill('SIGTERM');
  if (upstream) await new Promise((r) => upstream.close(r));
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------

test('healthz answers before any account exists', async () => {
  const res = await request('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('first run redirects everything to /setup', async () => {
  const res = await request('/');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/setup$/);
});

test('setup creates the account and issues a session', async () => {
  const res = await request('/api/setup', {
    method: 'POST',
    body: { username: 'tester', password: 'a-long-enough-password' },
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  cookie = setCookie.split(';')[0];
});

test('setup cannot be run twice', async () => {
  const res = await request('/api/setup', {
    method: 'POST',
    body: { username: 'attacker', password: 'another-password' },
  });
  assert.equal(res.status, 409);
});

test('writes require a session', async () => {
  const saved = cookie;
  cookie = '';
  const res = await request('/api/services', {
    method: 'POST',
    body: { name: 'Sneaky', hostname: 'sneaky', host: '1.2.3.4', port: 80 },
  });
  cookie = saved;
  assert.equal(res.status, 401);
});

test('a forged session cookie is rejected', async () => {
  const saved = cookie;
  cookie = 'urp_session=eyJ1IjoidGVzdGVyIiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.forged';
  const res = await request('/api/services', {
    method: 'POST',
    body: { name: 'Forged', hostname: 'forged', host: '1.2.3.4', port: 80 },
  });
  cookie = saved;
  assert.equal(res.status, 401);
});

test('adding a service returns its .local address', async () => {
  const res = await request('/api/services', {
    method: 'POST',
    body: {
      name: 'Open WebUI', hostname: 'openwebui', host: '127.0.0.1', port: UPSTREAM_PORT,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.service.fqdn, 'openwebui.local');
  assert.equal(res.json.service.preserveHost, true);
});

test('requests are proxied by Host header', async () => {
  const res = await request('/deep/path?a=1', { headers: { host: 'openwebui.local' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.url, '/deep/path?a=1');
  assert.equal(res.json.headers.host, 'openwebui.local');
  assert.ok(res.json.headers['x-forwarded-for']);
  assert.equal(res.json.headers['x-forwarded-host'], 'openwebui.local');
});

test('request bodies survive the round trip', async () => {
  const res = await request('/submit', {
    method: 'POST',
    headers: { host: 'openwebui.local' },
    body: { hello: 'world' },
  });
  assert.equal(res.json.method, 'POST');
  assert.equal(res.json.received, '{"hello":"world"}', 'body reached the upstream intact');
});

test('upstream redirects to its own ip:port are rewritten to the .local name', async () => {
  const res = await request('/redirect', { headers: { host: 'openwebui.local' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'http://openwebui.local/after');
});

test('WebSocket upgrades are spliced through', async () => {
  const socket = net.connect(PROXY_PORT, '127.0.0.1');
  const response = await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\nHost: openwebui.local\r\nUpgrade: websocket\r\n'
        + 'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.on('data', (chunk) => resolve(String(chunk)));
    setTimeout(() => reject(new Error('no upgrade response')), 5000);
  });
  socket.destroy();
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(response, /WS-OK/);
});

test('an unreachable upstream produces a 502 with a readable explanation', async () => {
  await request('/api/services', {
    method: 'POST',
    body: { name: 'Dead', hostname: 'dead', host: '127.0.0.1', port: 1 },
  });
  const res = await request('/', { headers: { host: 'dead.local' } });
  assert.equal(res.status, 502);
  assert.match(res.text, /not responding/i);
});

test('an unmapped .local name explains itself instead of 500ing', async () => {
  const res = await request('/', { headers: { host: 'ghost.local' } });
  assert.equal(res.status, 404);
  assert.match(res.text, /No service mapped/i);
});

test('a disabled service stops routing', async () => {
  const list = await request('/api/services');
  const service = list.json.services.find((s) => s.hostname === 'openwebui');
  await request(`/api/services/${service.id}`, { method: 'PUT', body: { enabled: false } });

  const res = await request('/', { headers: { host: 'openwebui.local' } });
  assert.equal(res.status, 404);

  await request(`/api/services/${service.id}`, { method: 'PUT', body: { enabled: true } });
  const back = await request('/', { headers: { host: 'openwebui.local' } });
  assert.equal(back.status, 200);
});

test('the public dashboard hides upstream addresses', async () => {
  const saved = cookie;
  cookie = '';
  const res = await request('/api/services');
  cookie = saved;
  assert.equal(res.status, 200);
  for (const service of res.json.services) {
    assert.equal(service.host, undefined, 'upstream host must not leak to anonymous callers');
    assert.equal(service.port, undefined, 'upstream port must not leak to anonymous callers');
    assert.ok(service.fqdn);
  }
});

test('static assets are served without path traversal', async () => {
  const ok = await request('/assets/style.css');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/css/);

  const escaped = await request('/assets/../../../../etc/passwd');
  assert.notEqual(escaped.status, 200);
});

test('the admin form has no duplicate element ids', () => {
  // Regression guard: a shared id between an input and a checkbox made
  // querySelector('#id').checked read the text input, silently saving false.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'assets', 'admin.js'), 'utf8',
  );
  const ids = [...source.matchAll(/(?:id: '|toggle\(')(f-[a-z-]+)'/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicates, [], `duplicate form ids: ${duplicates.join(', ')}`);
  assert.ok(ids.length >= 12, `expected the full form to be scanned, found ${ids.length} ids`);
});

// --- multiple domain suffixes ---------------------------------------------

test('a service answers on every configured suffix', async () => {
  const saved = await request('/api/settings');
  await request('/api/settings', {
    method: 'PUT',
    body: { ...saved.json.settings, domainSuffixes: ['local', 'home.arpa', 'lan'] },
  });

  for (const host of ['openwebui.local', 'openwebui.home.arpa', 'openwebui.lan']) {
    const res = await request('/ping', { headers: { host } });
    assert.equal(res.status, 200, `${host} should route`);
    assert.equal(res.json.url, '/ping');
  }

  // A suffix that is not configured must not route.
  const stranger = await request('/ping', { headers: { host: 'openwebui.example.com' } });
  assert.notEqual(stranger.status, 200);
});

test('the admin panel is reachable on every suffix too', async () => {
  for (const host of ['proxy.local', 'proxy.home.arpa', 'proxy.lan']) {
    const res = await request('/healthz', { headers: { host } });
    assert.equal(res.status, 200, `${host} should reach the admin app`);
  }
});

test('services report all their names and urls', async () => {
  const res = await request('/api/services');
  const service = res.json.services.find((s) => s.hostname === 'openwebui');
  assert.deepEqual(service.fqdns, ['openwebui.local', 'openwebui.home.arpa', 'openwebui.lan']);
  assert.equal(service.fqdn, 'openwebui.local', 'primary suffix leads');
  assert.equal(service.urls.length, 3);
});

test('mDNS claims only the .local names, and DNS-only names are reported', async () => {
  const res = await request('/api/system');
  const { mdns, dnsOnlyNames, wildcardRecords } = res.json;

  assert.ok(mdns.names.length > 0);
  for (const name of mdns.names) {
    assert.ok(name.endsWith('.local'), `mDNS must not claim ${name}`);
  }
  assert.ok(dnsOnlyNames.some((n) => n.endsWith('.home.arpa')));
  assert.ok(dnsOnlyNames.every((n) => !n.endsWith('.local')));

  assert.deepEqual(
    wildcardRecords.map((r) => r.record).sort(),
    ['*.home.arpa', '*.lan'],
    'the UI is told exactly which wildcard records to create',
  );
});

test('an invalid suffix list is rejected without changing anything', async () => {
  const before = await request('/api/settings');
  const bad = await request('/api/settings', {
    method: 'PUT',
    body: { ...before.json.settings, domainSuffixes: ['local', 'not a suffix'] },
  });
  assert.equal(bad.status, 400);

  const after = await request('/api/settings');
  assert.deepEqual(after.json.settings.domainSuffixes, before.json.settings.domainSuffixes);
});

test('suffix guidance is served for the settings UI', async () => {
  const res = await request('/api/settings');
  const local = res.json.suffixInfo.find((i) => i.suffix === 'local');
  assert.equal(local.resolves, 'mdns');
  const arpa = res.json.suffixInfo.find((i) => i.suffix === 'home.arpa');
  assert.equal(arpa.resolves, 'dns');
  assert.ok(res.json.suffixSuggestions.length >= 4);

  const risky = await request('/api/suffix-check?suffix=dev');
  assert.equal(risky.json.ok, true);
  assert.match(risky.json.warning, /HSTS/);
});

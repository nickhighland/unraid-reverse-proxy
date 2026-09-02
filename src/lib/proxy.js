'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const CONNECT_TIMEOUT_MS = 8000;

// Headers that describe a single hop and must not be forwarded (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15_000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15_000 }),
  httpsInsecure: new https.Agent({
    keepAlive: true, maxSockets: 128, keepAliveMsecs: 15_000, rejectUnauthorized: false,
  }),
};

function agentFor(service) {
  if (service.scheme !== 'https') return agents.http;
  return service.insecureTls ? agents.httpsInsecure : agents.https;
}

/** Copies headers minus the hop-by-hop set, including anything Connection names. */
function filterHeaders(headers) {
  const drop = new Set(HOP_BY_HOP);
  const connection = headers.connection;
  if (connection) {
    for (const token of String(connection).split(',')) {
      const name = token.trim().toLowerCase();
      if (name) drop.add(name);
    }
  }
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!drop.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function clientIp(req) {
  const raw = req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

function buildUpstreamHeaders(req, service, { proxyPort }) {
  const headers = filterHeaders(req.headers);
  const originalHost = String(req.headers.host || '').split(':')[0];

  headers.host = service.preserveHost
    ? req.headers.host
    : `${service.host}:${service.port}`;

  const existingFor = req.headers['x-forwarded-for'];
  const ip = clientIp(req);
  headers['x-forwarded-for'] = existingFor ? `${existingFor}, ${ip}` : ip;
  headers['x-real-ip'] = ip;
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = req.headers.host || originalHost;
  headers['x-forwarded-port'] = String(proxyPort);
  return headers;
}

/**
 * If the upstream redirects to its own ip:port, point the client back at the
 * .local name instead — otherwise the browser leaves the proxy on first login.
 */
function rewriteLocation(location, req, service, proxyPort) {
  if (!location || !service.rewriteRedirects) return location;
  const publicHost = req.headers.host;
  if (!publicHost) return location;

  const candidates = [
    `${service.scheme}://${service.host}:${service.port}`,
    `${service.scheme}://${service.host}`,
    `http://${service.host}:${service.port}`,
    `https://${service.host}:${service.port}`,
  ];
  for (const origin of candidates) {
    if (location.toLowerCase().startsWith(origin.toLowerCase())) {
      return `http://${publicHost}${location.slice(origin.length) || '/'}`;
    }
  }
  return location;
}

function guardConnect(clientReq, onTimeout) {
  clientReq.on('socket', (socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(onTimeout, CONNECT_TIMEOUT_MS);
    const clear = () => clearTimeout(timer);
    socket.once('connect', clear);
    socket.once('secureConnect', clear);
    socket.once('error', clear);
    socket.once('close', clear);
  });
}

function errorPage({ service, code, detail }) {
  const target = `${service.scheme}://${service.host}:${service.port}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(service.name)} is unreachable</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1420;color:#e6ebf5;
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:520px;background:#161d2c;border:1px solid #26304a;border-radius:16px;padding:32px}
h1{margin:0 0 8px;font-size:22px}
p{margin:0 0 16px;color:#9aa7bd}
code{background:#0f1420;border:1px solid #26304a;border-radius:6px;padding:2px 6px;font-size:13px;color:#8fd0ff}
a{color:#4f8cff}
.dot{width:10px;height:10px;border-radius:50%;background:#e06c75;display:inline-block;margin-right:8px}
</style></head><body><div class="card">
<h1><span class="dot"></span>${esc(service.name)} is not responding</h1>
<p>The proxy could not reach <code>${esc(target)}</code>.</p>
<p>${esc(detail || code || 'The upstream container refused the connection.')}</p>
<p>Check that the container is running and that the address and port are correct.</p>
<p><a href="/">&larr; Back to the dashboard</a></p>
</div></body></html>`;
}

function reasonFor(err) {
  switch (err.code) {
    case 'ECONNREFUSED': return 'Nothing is listening on that address and port.';
    case 'EHOSTUNREACH': return 'That host is unreachable from the proxy container.';
    case 'ENOTFOUND': return 'That hostname could not be resolved.';
    case 'ETIMEDOUT': return 'The connection attempt timed out.';
    case 'ECONNRESET': return 'The upstream closed the connection unexpectedly.';
    case 'EPROTO': return 'TLS handshake failed — is this service really HTTPS?';
    default: return err.message;
  }
}

/** Proxies a normal HTTP request/response pair. */
function forward(req, res, service, { proxyPort, logger = console }) {
  const options = {
    protocol: `${service.scheme}:`,
    host: service.host,
    port: service.port,
    method: req.method,
    path: req.url,
    headers: buildUpstreamHeaders(req, service, { proxyPort }),
    agent: agentFor(service),
    setHost: false,
  };

  const mod = service.scheme === 'https' ? https : http;
  let settled = false;

  const upstream = mod.request(options, (upRes) => {
    settled = true;
    const headers = filterHeaders(upRes.headers);
    if (headers.location) {
      headers.location = rewriteLocation(headers.location, req, service, proxyPort);
    }
    try {
      res.writeHead(upRes.statusCode, upRes.statusMessage, headers);
    } catch (err) {
      logger.warn(`[proxy] ${service.hostname}: bad upstream headers (${err.message})`);
      upRes.destroy();
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad gateway: upstream sent malformed headers.');
      return;
    }
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });

  guardConnect(upstream, () => {
    const err = new Error('Connection timed out');
    err.code = 'ETIMEDOUT';
    upstream.destroy(err);
  });

  upstream.on('error', (err) => {
    if (settled) {
      res.destroy();
      return;
    }
    settled = true;
    logger.warn(`[proxy] ${service.hostname} -> ${service.host}:${service.port} failed: ${err.code || err.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(errorPage({ service, code: err.code, detail: reasonFor(err) }));
  });

  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
  req.on('error', () => upstream.destroy());
}

/** Proxies a WebSocket (or any other) protocol upgrade by splicing sockets. */
function forwardUpgrade(req, clientSocket, head, service, { proxyPort, logger = console }) {
  if (!service.websockets) {
    clientSocket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
    return;
  }

  const headers = buildUpstreamHeaders(req, service, { proxyPort });
  // Upgrade and Connection are hop-by-hop, but this hop *is* the upgrade.
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;

  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`);
  }
  const preamble = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');

  const onFail = (err) => {
    logger.warn(`[proxy] websocket ${service.hostname} failed: ${err.code || err.message}`);
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  };

  const connectOpts = { host: service.host, port: service.port };
  const upstream = service.scheme === 'https'
    ? tls.connect({ ...connectOpts, rejectUnauthorized: !service.insecureTls, servername: service.host })
    : net.connect(connectOpts);

  const timer = setTimeout(() => {
    const err = new Error('Connection timed out');
    err.code = 'ETIMEDOUT';
    upstream.destroy(err);
  }, CONNECT_TIMEOUT_MS);

  upstream.once(service.scheme === 'https' ? 'secureConnect' : 'connect', () => {
    clearTimeout(timer);
    upstream.write(preamble);
    if (head && head.length) upstream.write(head);
    upstream.setNoDelay(true);
    clientSocket.setNoDelay(true);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    clearTimeout(timer);
    onFail(err);
  });
  clientSocket.on('error', () => upstream.destroy());
  clientSocket.on('close', () => upstream.destroy());
  upstream.on('close', () => clientSocket.destroy());
}

module.exports = { forward, forwardUpgrade, errorPage, filterHeaders, rewriteLocation };

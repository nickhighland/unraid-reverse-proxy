'use strict';

const http = require('http');
const path = require('path');
const { URL } = require('url');

const config = require('./lib/config');
const auth = require('./lib/auth');
const proxy = require('./lib/proxy');
const netinfo = require('./lib/netinfo');
const { MdnsResponder } = require('./lib/mdns');
const icons = require('./lib/icons');
const { HealthMonitor } = require('./lib/health');
const { handleApi } = require('./routes/api');
const {
  sendJson, sendText, redirect, serveStatic, escapeHtml,
} = require('./lib/http-util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = require('../package.json').version;

const logger = {
  info: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
  warn: (msg) => console.warn(`${new Date().toISOString()} ${msg}`),
  error: (msg) => console.error(`${new Date().toISOString()} ${msg}`),
};

const cfg = config.load();
const httpPort = Number(process.env.HTTP_PORT) || cfg.settings.httpPort || 80;

const health = new HealthMonitor(() => config.load().services, {
  intervalSeconds: cfg.settings.healthCheckSeconds,
  logger,
});
const mdns = new MdnsResponder({ logger });

/** Recomputes everything that depends on the stored configuration. */
function refresh() {
  const current = config.load();
  const ip = netinfo.advertiseIp(current.settings);
  const names = current.services
    .filter((s) => s.enabled)
    .map((s) => config.fqdn(s, current));
  names.push(config.adminFqdn(current));

  if (current.settings.mdnsEnabled) {
    if (!mdns.running && !mdns.socket) {
      mdns.setRecords(names, ip);
      mdns.start(netinfo.ipv4Interfaces().map((i) => i.address));
    } else {
      mdns.setRecords(names, ip);
    }
  } else if (mdns.socket) {
    mdns.stop();
  }

  health.setInterval(current.settings.healthCheckSeconds);
}

function systemInfo() {
  const current = config.load();
  return {
    version: VERSION,
    advertiseIp: netinfo.advertiseIp(current.settings),
    detectedIp: netinfo.detectLanIp(),
    interfaces: netinfo.ipv4Interfaces(),
    mdns: {
      enabled: current.settings.mdnsEnabled,
      running: mdns.running,
      names: mdns.names,
    },
    bridgeWarning: netinfo.looksLikeDockerBridge(netinfo.advertiseIp(current.settings)),
    httpPort,
    configFile: config.CONFIG_FILE,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  };
}

/** Maps an incoming Host header to a configured service, if any. */
function resolveService(hostHeader) {
  const current = config.load();
  const host = String(hostHeader || '').split(':')[0].toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const suffix = `.${current.settings.domainSuffix}`;
  const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : host;
  if (label === current.settings.adminHostname) return null;
  const service = current.services.find((s) => s.hostname === label && s.enabled);
  return service || null;
}

function isOurHost(hostHeader) {
  const current = config.load();
  const host = String(hostHeader || '').split(':')[0].toLowerCase().replace(/\.$/, '');
  const suffix = `.${current.settings.domainSuffix}`;
  return host === config.adminFqdn(current) || host === current.settings.adminHostname
    || !host.endsWith(suffix);
}

function unmappedPage(hostHeader) {
  const current = config.load();
  const host = escapeHtml(String(hostHeader || '').split(':')[0]);
  const admin = escapeHtml(config.adminFqdn(current));
  const port = httpPort === 80 ? '' : `:${httpPort}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${host} is not mapped</title>
<style>:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#0f1420;color:#e6ebf5;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:480px;background:#161d2c;border:1px solid #26304a;border-radius:16px;padding:32px}
h1{margin:0 0 12px;font-size:21px}p{margin:0 0 14px;color:#9aa7bd}a{color:#4f8cff}
code{background:#0f1420;border:1px solid #26304a;border-radius:6px;padding:2px 6px;color:#8fd0ff}</style>
</head><body><div class="card"><h1>No service mapped to ${host}</h1>
<p>This proxy is running, but nothing is configured for <code>${host}</code>.</p>
<p><a href="http://${admin}${port}/admin">Open the admin panel</a> to add it.</p>
</div></body></html>`;
}

// --- admin / dashboard app --------------------------------------------------

async function handleAdminApp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const authenticated = Boolean(auth.sessionUser(req));
  const configured = auth.isConfigured();
  const current = config.load();

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, version: VERSION, services: current.services.length });
  }

  if (pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, {
        url, health, mdns, authenticated, refresh, systemInfo, httpPort,
      });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) logger.error(`[api] ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) return sendJson(res, status, { error: err.message });
      return res.end();
    }
  }

  if (pathname.startsWith('/icons/')) {
    const served = await serveStatic(res, icons.ICON_DIR, pathname.slice('/icons'.length), { cache: true });
    if (served) return undefined;
    return sendText(res, 404, 'Not found');
  }

  if (pathname.startsWith('/assets/')) {
    // 'no-cache' still allows revalidation, but never serves stale JS after an update.
    const served = await serveStatic(res, PUBLIC_DIR, pathname);
    if (served) return undefined;
    return sendText(res, 404, 'Not found');
  }

  // First run: force account creation before anything else is reachable.
  if (!configured && pathname !== '/setup') return redirect(res, '/setup');
  if (configured && pathname === '/setup') return redirect(res, authenticated ? '/admin' : '/login');

  if (pathname === '/setup') return page(res, 'setup.html');
  if (pathname === '/login') {
    if (authenticated) return redirect(res, '/admin');
    return page(res, 'login.html');
  }
  if (pathname === '/admin') {
    if (!authenticated) return redirect(res, '/login?next=/admin');
    return page(res, 'admin.html');
  }
  if (pathname === '/') {
    if (current.settings.dashboardRequiresLogin && !authenticated) {
      return redirect(res, '/login');
    }
    return page(res, 'index.html');
  }

  return sendText(res, 404, 'Not found');
}

async function page(res, file) {
  const served = await serveStatic(res, PUBLIC_DIR, `/${file}`);
  if (!served) sendText(res, 500, `Missing template: ${file}`);
}

// --- server -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const service = resolveService(req.headers.host);
  if (service) {
    return proxy.forward(req, res, service, { proxyPort: httpPort, logger });
  }
  if (!isOurHost(req.headers.host)) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(unmappedPage(req.headers.host));
  }
  return handleAdminApp(req, res).catch((err) => {
    logger.error(`[http] ${err.stack || err.message}`);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
    else res.destroy();
  });
});

server.on('upgrade', (req, socket, head) => {
  const service = resolveService(req.headers.host);
  if (!service) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  proxy.forwardUpgrade(req, socket, head, service, { proxyPort: httpPort, logger });
});

server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Long-lived streams (SSE, log tails) must not be cut off by the default timeout.
server.headersTimeout = 60_000;
server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 72_000;

server.on('error', (err) => {
  if (err.code === 'EACCES' && httpPort < 1024) {
    logger.error(`[http] Permission denied binding port ${httpPort}. Run the container as root or pick a port above 1024.`);
  } else if (err.code === 'EADDRINUSE') {
    logger.error(`[http] Port ${httpPort} is already in use. On Unraid the web GUI owns port 80 by default — `
      + 'give this container its own IP on br0, or move the Unraid GUI to another port.');
  } else {
    logger.error(`[http] ${err.message}`);
  }
  process.exit(1);
});

server.listen(httpPort, () => {
  const current = config.load();
  const ip = netinfo.advertiseIp(current.settings);
  logger.info(`Unraid Reverse Proxy ${VERSION} listening on port ${httpPort}`);
  logger.info(`Advertising ${config.adminFqdn(current)} -> ${ip}`);
  if (current.settings.mdnsEnabled && netinfo.looksLikeDockerBridge(ip)) {
    logger.warn('');
    logger.warn(`[setup] ${ip} is a Docker bridge address that only exists inside this host.`);
    logger.warn('[setup] .local names will resolve to an address nothing on your LAN can reach.');
    logger.warn('[setup] Fix: give this container its own IP — on Unraid set Network Type to');
    logger.warn('[setup] "Custom: br0" with a fixed IP outside your DHCP pool, or use host networking.');
    logger.warn('');
  }
  logger.info(`Config: ${config.CONFIG_FILE}`);
  if (!auth.isConfigured()) {
    logger.info(`First run: open http://${ip}${httpPort === 80 ? '' : `:${httpPort}`}/setup to create your login.`);
  }
  refresh();
  health.start();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down.`);
  health.stop();
  mdns.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => logger.error(`[uncaught] ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => logger.error(`[unhandled] ${err?.stack || err}`));

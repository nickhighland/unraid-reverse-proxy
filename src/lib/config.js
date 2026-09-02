'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function defaults() {
  return {
    version: 1,
    settings: {
      httpPort: Number(process.env.HTTP_PORT) || 80,
      domainSuffixes: ['local'],
      adminHostname: 'proxy',
      advertiseIp: 'auto',
      mdnsEnabled: true,
      dashboardRequiresLogin: false,
      dashboardTitle: 'Unraid Services',
      healthCheckSeconds: 30,
      sessionDays: 30,
    },
    auth: null,
    sessionSecret: null,
    services: [],
  };
}

let cache = null;

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[config] ${CONFIG_FILE} is unreadable (${err.message}); starting from defaults.`);
      try {
        fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.broken-${Date.now()}`);
      } catch { /* best effort */ }
    }
  }

  const cfg = defaults();
  if (raw && typeof raw === 'object') {
    const rawSettings = raw.settings || {};
    Object.assign(cfg.settings, rawSettings);
    // v1 stored a single `domainSuffix` string. Test the file rather than the
    // merged object, whose domainSuffixes is already populated by defaults().
    if (!Array.isArray(rawSettings.domainSuffixes) && typeof rawSettings.domainSuffix === 'string') {
      cfg.settings.domainSuffixes = [rawSettings.domainSuffix];
    }
    delete cfg.settings.domainSuffix;
    if (!Array.isArray(cfg.settings.domainSuffixes) || !cfg.settings.domainSuffixes.length) {
      cfg.settings.domainSuffixes = ['local'];
    }
    cfg.auth = raw.auth || null;
    cfg.sessionSecret = raw.sessionSecret || null;
    cfg.services = Array.isArray(raw.services) ? raw.services.map(normalizeService) : [];
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  cache = cfg;
  if (!raw) save();
  return cache;
}

function save() {
  ensureDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  return cache;
}

function normalizeService(s) {
  return {
    id: s.id || crypto.randomBytes(6).toString('hex'),
    name: String(s.name || '').trim(),
    hostname: String(s.hostname || '').trim().toLowerCase(),
    scheme: s.scheme === 'https' ? 'https' : 'http',
    host: String(s.host || '').trim(),
    port: Number(s.port) || 80,
    description: String(s.description || '').trim(),
    icon: String(s.icon || '').trim(),
    color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : pickColor(s.name || s.hostname || ''),
    enabled: s.enabled !== false,
    showOnDashboard: s.showOnDashboard !== false,
    preserveHost: s.preserveHost !== false,
    websockets: s.websockets !== false,
    insecureTls: s.insecureTls === true,
    rewriteRedirects: s.rewriteRedirects !== false,
  };
}

const PALETTE = [
  '#4f8cff', '#22c1a4', '#f0883e', '#c678dd', '#e06c75',
  '#56b6c2', '#98c379', '#e5c07b', '#61afef', '#ff7eb6',
];

function pickColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/**
 * Validates user-supplied service fields. Returns { ok, error, service }.
 * `existingId` lets an edit keep its own hostname without tripping the uniqueness check.
 */
function validateService(input, existingId = null) {
  const cfg = load();
  const suffix = primarySuffix(cfg);

  const name = String(input.name || '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (name.length > 60) return { ok: false, error: 'Name must be 60 characters or fewer.' };

  // Accept "openwebui", "openwebui.local", or "OpenWebUI." — store just the label.
  // Accept "openwebui", "openwebui.local", "openwebui.home" — store just the label.
  let hostname = stripSuffix(String(input.hostname || '').trim(), cfg).replace(/\.$/, '');
  if (!hostname) return { ok: false, error: 'Hostname is required.' };
  if (!HOSTNAME_RE.test(hostname)) {
    return { ok: false, error: 'Hostname may only contain letters, numbers and hyphens, and cannot start or end with a hyphen.' };
  }
  if (hostname === cfg.settings.adminHostname) {
    return { ok: false, error: `"${hostname}" is reserved for this proxy's own admin interface.` };
  }
  const clash = cfg.services.find((s) => s.hostname === hostname && s.id !== existingId);
  if (clash) return { ok: false, error: `Hostname "${hostname}.${suffix}" is already used by "${clash.name}".` };

  let host = String(input.host || '').trim();
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  // Tolerate "192.168.1.10:8080" pasted into the address field.
  let portFromHost = null;
  const hostPort = host.match(/^(.*):(\d+)$/);
  if (hostPort && !host.includes(']')) {
    host = hostPort[1];
    portFromHost = Number(hostPort[2]);
  }
  if (!host) return { ok: false, error: 'Target address is required.' };
  if (/\s/.test(host)) return { ok: false, error: 'Target address cannot contain spaces.' };

  const port = Number(input.port ?? portFromHost ?? 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Target port must be a whole number between 1 and 65535.' };
  }

  const service = normalizeService({
    ...input,
    id: existingId || undefined,
    name,
    hostname,
    host,
    port,
  });
  return { ok: true, service };
}

/** Every configured suffix, primary first. Never empty. */
function suffixes(cfg = load()) {
  const list = cfg.settings.domainSuffixes;
  return Array.isArray(list) && list.length ? list : ['local'];
}

/** The suffix used for display and for the links on the dashboard. */
function primarySuffix(cfg = load()) {
  return suffixes(cfg)[0];
}

function fqdn(service, cfg = load()) {
  return `${service.hostname}.${primarySuffix(cfg)}`;
}

/** Every name this service answers to, one per configured suffix. */
function allFqdns(service, cfg = load()) {
  return suffixes(cfg).map((suffix) => `${service.hostname}.${suffix}`);
}

function adminFqdn(cfg = load()) {
  return `${cfg.settings.adminHostname}.${primarySuffix(cfg)}`;
}

function allAdminFqdns(cfg = load()) {
  return suffixes(cfg).map((suffix) => `${cfg.settings.adminHostname}.${suffix}`);
}

/** Strips whichever configured suffix a host ends with, returning the label. */
function stripSuffix(host, cfg = load()) {
  const clean = String(host || '').toLowerCase().replace(/\.$/, '');
  for (const suffix of suffixes(cfg)) {
    if (clean.endsWith(`.${suffix}`)) return clean.slice(0, -(suffix.length + 1));
  }
  return clean;
}

function hasKnownSuffix(host, cfg = load()) {
  const clean = String(host || '').toLowerCase().replace(/\.$/, '');
  return suffixes(cfg).some((suffix) => clean.endsWith(`.${suffix}`));
}

function publicUrl(service, cfg = load()) {
  const port = cfg.settings.httpPort;
  const suffix = port === 80 ? '' : `:${port}`;
  return `http://${fqdn(service, cfg)}${suffix}/`;
}

/** One URL per configured suffix, in the same order. */
function publicUrls(service, cfg = load()) {
  const port = cfg.settings.httpPort;
  const portPart = port === 80 ? '' : `:${port}`;
  return allFqdns(service, cfg).map((name) => `http://${name}${portPart}/`);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  HOSTNAME_RE,
  suffixes,
  primarySuffix,
  allFqdns,
  allAdminFqdns,
  stripSuffix,
  hasKnownSuffix,
  publicUrls,
  load,
  save,
  normalizeService,
  validateService,
  pickColor,
  fqdn,
  adminFqdn,
  publicUrl,
};

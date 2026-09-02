'use strict';

const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'urp_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, auth) {
  if (!auth || !auth.salt || !auth.hash) return false;
  const { hash } = hashPassword(password, auth.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isConfigured() {
  const cfg = config.load();
  return Boolean(cfg.auth && cfg.auth.hash);
}

function createAccount(username, password) {
  const cfg = config.load();
  const name = String(username || '').trim();
  if (name.length < 2) return { ok: false, error: 'Username must be at least 2 characters.' };
  if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const { salt, hash } = hashPassword(password);
  cfg.auth = { username: name, salt, hash, createdAt: new Date().toISOString() };
  // Rotating the secret signs every existing session out.
  cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  config.save();
  return { ok: true };
}

function changePassword(currentPassword, newPassword) {
  const cfg = config.load();
  if (!verifyPassword(currentPassword, cfg.auth)) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  if (String(newPassword || '').length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' };
  }
  const { salt, hash } = hashPassword(newPassword);
  cfg.auth = { ...cfg.auth, salt, hash };
  cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  config.save();
  return { ok: true };
}

function sign(payload) {
  const cfg = config.load();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const cfg = config.load();
  const [body, mac] = token.split('.', 2);
  const expected = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function createSession(username) {
  const cfg = config.load();
  const days = Number(cfg.settings.sessionDays) || 30;
  const exp = Date.now() + days * 86400_000;
  return { token: sign({ u: username, exp }), maxAge: Math.floor((exp - Date.now()) / 1000) };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const payload = unsign(token);
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  const cfg = config.load();
  if (!cfg.auth || cfg.auth.username !== payload.u) return null;
  return payload.u;
}

function cookieHeader(token, maxAge) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// --- Login throttling -------------------------------------------------------
// Plain in-memory counters. This is a LAN tool; the goal is to blunt scripted
// guessing, not to survive a restart.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60_000;

function throttleStatus(key) {
  const rec = attempts.get(key);
  if (!rec) return { blocked: false };
  if (Date.now() > rec.until) {
    attempts.delete(key);
    return { blocked: false };
  }
  if (rec.count >= MAX_ATTEMPTS) {
    return { blocked: true, retryAfter: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  return { blocked: false };
}

function recordFailure(key) {
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, rec);
}

function recordSuccess(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE,
  isConfigured,
  createAccount,
  changePassword,
  verifyPassword,
  createSession,
  sessionUser,
  parseCookies,
  cookieHeader,
  clearCookieHeader,
  throttleStatus,
  recordFailure,
  recordSuccess,
};

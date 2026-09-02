'use strict';

/**
 * Icon library backed by the Unraid Community Applications feed.
 *
 * The published feed is ~24 MB of full application templates, which is far too
 * much to ship in the image or keep in memory. Instead we fetch it on demand,
 * distil it into a ~500 KB name/icon index cached under CONFIG_DIR, and search
 * that. Chosen icons can be copied locally so the dashboard keeps working when
 * the upstream host is unreachable.
 *
 * Everything in the feed is third-party, user-contributed data. It is only ever
 * treated as data: names are rendered as text and icon URLs are validated to be
 * plain http(s) before use.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { CONFIG_DIR } = require('./config');

const INDEX_FILE = path.join(CONFIG_DIR, 'icon-index.json');
const ICON_DIR = path.join(CONFIG_DIR, 'icons');

const FEED_URLS = [
  'https://assets.ca.unraid.net/feed/applicationFeed.json',
  'https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json',
];

const FEED_TIMEOUT_MS = 90_000;
const MAX_FEED_BYTES = 64 * 1024 * 1024;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const INDEX_TTL_MS = 7 * 24 * 3600_000;

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

/**
 * The opening view of the picker. Sorting the whole catalogue by download count
 * just surfaces database sidecars (*-redis, *-postgres), so instead we resolve a
 * shortlist of apps people actually map against the live index — the icons stay
 * current, only the ordering is opinionated.
 */
const STARTER_APPS = [
  'plex', 'jellyfin', 'emby', 'sonarr', 'radarr', 'lidarr', 'prowlarr', 'bazarr',
  'overseerr', 'jellyseerr', 'tautulli', 'qbittorrent', 'deluge', 'transmission',
  'sabnzbd', 'nzbget', 'home assistant', 'node-red', 'zigbee2mqtt', 'frigate',
  'nextcloud', 'immich', 'photoprism', 'paperless-ngx', 'vaultwarden', 'portainer',
  'grafana', 'influxdb', 'prometheus', 'uptime kuma', 'heimdall', 'organizr',
  'homer', 'pihole', 'adguard', 'unifi', 'wireguard', 'tailscale',
  'nginx proxy manager', 'swag', 'duplicati', 'syncthing', 'krusader', 'handbrake',
  'tdarr', 'calibre', 'audiobookshelf', 'navidrome', 'open-webui', 'ollama',
  'code-server', 'gitea', 'minio', 'mealie', 'firefly', 'stirling-pdf', 'kavita',
  'komga', 'esphome', 'scrutiny', 'netdata', 'dozzle', 'watchtower', 'dockge',
  'bookstack', 'vikunja', 'guacamole', 'wikijs', 'rustdesk', 'mariadb',
];

let memoryIndex = null;
let refreshing = null;

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * GitHub "blob" links render an HTML page, not an image. The feed contains a
 * few hundred of them; rewriting to raw.githubusercontent.com makes them load.
 */
function normalizeIconUrl(raw) {
  if (!isHttpUrl(raw)) return null;
  const url = new URL(raw);
  if (url.hostname === 'github.com' && url.pathname.includes('/blob/')) {
    url.hostname = 'raw.githubusercontent.com';
    url.pathname = url.pathname.replace('/blob/', '/');
    return url.toString();
  }
  return url.toString();
}

/** Collapses a feed entry into the handful of fields the picker needs. */
function slim(app) {
  const name = typeof app.Name === 'string' ? app.Name.trim() : '';
  const icon = normalizeIconUrl(app.Icon);
  if (!name || !icon) return null;
  // Blacklisted templates are pulled for cause, so skip them. Deprecated ones
  // are kept: this is an icon library, and people still run older containers.
  if (app.Blacklist === true) return null;

  const downloads = Number(app.downloads) || 0;
  const stars = Number(app.stars) || 0;
  // A single 0-100 popularity figure keeps the cached index small.
  const popularity = Math.round(
    Math.min(100, Math.log10(downloads + 1) * 9 + Math.log10(stars + 1) * 4),
  );

  const entry = {
    n: name,
    i: icon,
    r: String(app.Repo || '').replace(/'s Repository$/, '').trim(),
    p: popularity,
  };
  if (app.Official === true || app.Official === 'true') entry.o = 1;
  const extra = app.ExtraSearchTerms;
  if (typeof extra === 'string' && extra.trim()) entry.x = extra.trim().slice(0, 120);
  return entry;
}

function dedupe(entries) {
  const best = new Map();
  for (const entry of entries) {
    const key = `${entry.n.toLowerCase()}|${entry.i}`;
    const existing = best.get(key);
    if (!existing || entry.p > existing.p) best.set(key, entry);
  }
  return [...best.values()];
}

async function fetchFeed() {
  const errors = [];
  for (const url of FEED_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'unraid-reverse-proxy' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_FEED_BYTES) throw new Error(`feed too large (${declared} bytes)`);

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_FEED_BYTES) throw new Error('feed exceeded the size limit');
      return { json: JSON.parse(buffer.toString('utf8')), source: url };
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not fetch the Community Applications feed. ${errors.join('; ')}`);
}

async function refreshIndex() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { json, source } = await fetchFeed();
    const apps = Array.isArray(json) ? json : (json.applist || json.apps || []);
    if (!Array.isArray(apps)) throw new Error('Unexpected feed shape.');

    const entries = dedupe(apps.map(slim).filter(Boolean))
      .sort((a, b) => b.p - a.p);

    const index = { fetchedAt: new Date().toISOString(), source, entries };
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    const tmp = `${INDEX_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(index));
    await fsp.rename(tmp, INDEX_FILE);
    memoryIndex = index;
    return index;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function readCachedIndex() {
  if (memoryIndex) return memoryIndex;
  try {
    memoryIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return memoryIndex;
  } catch {
    return null;
  }
}

function isStale(index) {
  if (!index?.fetchedAt) return true;
  return Date.now() - Date.parse(index.fetchedAt) > INDEX_TTL_MS;
}

/**
 * Returns the index, fetching it if absent. A stale index is returned
 * immediately and refreshed in the background so search stays responsive.
 */
async function getIndex({ force = false } = {}) {
  if (force) return refreshIndex();
  const cached = readCachedIndex();
  if (!cached) return refreshIndex();
  if (isStale(cached)) {
    refreshIndex().catch(() => { /* keep serving the stale index */ });
  }
  return cached;
}

function normalizeTerm(value) {
  return String(value).toLowerCase().replace(/[\s._-]+/g, '');
}

/** Scores one entry against a query; higher is better, 0 means no match. */
function score(entry, rawQuery, tightQuery) {
  const name = entry.n.toLowerCase();
  const tightName = normalizeTerm(entry.n);

  let base = 0;
  if (name === rawQuery || tightName === tightQuery) base = 1000;
  else if (name.startsWith(rawQuery) || tightName.startsWith(tightQuery)) base = 600;
  else if (new RegExp(`\\b${rawQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) base = 400;
  else if (tightName.includes(tightQuery)) base = 250;
  else if (entry.x && normalizeTerm(entry.x).includes(tightQuery)) base = 150;
  else if (entry.r && normalizeTerm(entry.r).includes(tightQuery)) base = 80;

  if (!base) return 0;
  // Shorter names that still match are usually the app itself, not a companion tool.
  const brevity = Math.max(0, 30 - Math.abs(tightName.length - tightQuery.length));
  return base + entry.p * 2 + (entry.o ? 40 : 0) + brevity;
}

async function search(query, limit = 40) {
  const index = await getIndex();
  const entries = index?.entries || [];
  const rawQuery = String(query || '').trim().toLowerCase();

  if (!rawQuery) {
    const seenIcon = new Set();
    const browse = [];
    for (const term of STARTER_APPS) {
      const tight = normalizeTerm(term);
      let best = null;
      let bestScore = 0;
      for (const entry of entries) {
        const value = score(entry, term, tight);
        if (value > bestScore) { bestScore = value; best = entry; }
      }
      if (!best || seenIcon.has(best.i)) continue;
      seenIcon.add(best.i);
      browse.push(present(best));
      if (browse.length >= limit) break;
    }
    return { results: browse, total: entries.length, fetchedAt: index?.fetchedAt || null };
  }

  const tightQuery = normalizeTerm(rawQuery);
  const scored = [];
  for (const entry of entries) {
    const value = score(entry, rawQuery, tightQuery);
    if (value > 0) scored.push({ entry, value });
  }
  scored.sort((a, b) => b.value - a.value || a.entry.n.localeCompare(b.entry.n));

  return {
    results: scored.slice(0, limit).map((s) => present(s.entry)),
    total: scored.length,
    fetchedAt: index?.fetchedAt || null,
  };
}

function present(entry) {
  return {
    name: entry.n, icon: entry.i, repo: entry.r, popularity: entry.p, official: Boolean(entry.o),
  };
}

// --- local copies -----------------------------------------------------------

async function ensureIconDir() {
  await fsp.mkdir(ICON_DIR, { recursive: true });
}

function extensionFor(contentType, url) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const guess = path.extname(new URL(url, 'http://x').pathname).toLowerCase();
  return Object.values(EXT_BY_TYPE).includes(guess) ? guess : '.png';
}

/** Downloads a remote icon into CONFIG_DIR/icons and returns its local path. */
async function cacheRemoteIcon(rawUrl) {
  const url = normalizeIconUrl(rawUrl);
  if (!url) throw Object.assign(new Error('Icon URL must be http or https.'), { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'unraid-reverse-proxy' },
    });
    if (!res.ok) throw Object.assign(new Error(`Icon download failed (HTTP ${res.status}).`), { status: 502 });

    const contentType = res.headers.get('content-type') || '';
    if (!/^image\//i.test(contentType) && !/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(new URL(url).pathname)) {
      throw Object.assign(new Error('That URL did not return an image.'), { status: 400 });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_ICON_BYTES) {
      throw Object.assign(new Error('Icon is larger than 2 MB.'), { status: 413 });
    }

    await ensureIconDir();
    const name = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)
      + extensionFor(contentType, url);
    await fsp.writeFile(path.join(ICON_DIR, name), buffer);
    return { path: `/icons/${name}`, bytes: buffer.length };
  } finally {
    clearTimeout(timer);
  }
}

/** Stores an icon uploaded straight from the browser. */
async function saveUploadedIcon(buffer, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!EXT_BY_TYPE[type]) {
    throw Object.assign(new Error('Upload must be a PNG, JPEG, GIF, WebP, SVG or ICO image.'), { status: 400 });
  }
  if (!buffer.length) throw Object.assign(new Error('Upload was empty.'), { status: 400 });
  if (buffer.length > MAX_ICON_BYTES) {
    throw Object.assign(new Error('Icon is larger than 2 MB.'), { status: 413 });
  }
  await ensureIconDir();
  const name = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16) + EXT_BY_TYPE[type];
  await fsp.writeFile(path.join(ICON_DIR, name), buffer);
  return { path: `/icons/${name}`, bytes: buffer.length };
}

function indexStatus() {
  const index = readCachedIndex();
  return {
    available: Boolean(index),
    count: index?.entries?.length || 0,
    fetchedAt: index?.fetchedAt || null,
    source: index?.source || null,
    stale: index ? isStale(index) : true,
    refreshing: Boolean(refreshing),
  };
}

module.exports = {
  ICON_DIR,
  INDEX_FILE,
  search,
  refreshIndex,
  getIndex,
  cacheRemoteIcon,
  saveUploadedIcon,
  indexStatus,
  normalizeIconUrl,
  MAX_ICON_BYTES,
};

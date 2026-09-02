'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const MAX_BODY_BYTES = 512 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { location, 'cache-control': 'no-store' });
  res.end();
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      throw Object.assign(new Error('Body must be a JSON object'), { status: 400 });
    }
    return parsed;
  } catch (err) {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400, cause: err });
  }
}

/** Serves a file from `root`, refusing anything that escapes it. */
async function serveStatic(res, root, urlPath, { cache = false } = {}) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(root, safe);
  const resolvedRoot = path.resolve(root);
  if (!path.resolve(target).startsWith(resolvedRoot + path.sep) && path.resolve(target) !== resolvedRoot) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': cache ? 'public, max-age=300' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = {
  sendJson, sendText, redirect, readBody, readJson, serveStatic, escapeHtml, MIME,
};

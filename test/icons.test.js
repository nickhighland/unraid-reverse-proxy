'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'urp-icons-'));

const icons = require('../src/lib/icons');

// A stand-in catalogue with the shapes that matter: an exact match competing
// with a popular near-match, a version family, and a hyphen/space mismatch.
const FIXTURE = {
  fetchedAt: new Date().toISOString(),
  source: 'fixture',
  entries: [
    { n: 'plex', i: 'https://cdn.test/plex-ls.png', r: 'linuxserver', p: 94 },
    { n: 'PlexLibrarian', i: 'https://cdn.test/plexlibrarian.png', r: 'someone', p: 40 },
    { n: 'Music-Manager-for-Plex', i: 'https://cdn.test/mm.png', r: 'zcaddick', p: 30 },
    { n: 'open-webui', i: 'https://cdn.test/openwebui.png', r: 'joly0', p: 20 },
    { n: 'postgresql16', i: 'https://cdn.test/pg.png', r: 'sgraaf', p: 88 },
    { n: 'postgresql17', i: 'https://cdn.test/pg.png', r: 'sgraaf', p: 87 },
    { n: 'jellyfin', i: 'https://cdn.test/jellyfin.png', r: 'linuxserver', p: 90 },
    { n: 'Overseerr', i: 'https://cdn.test/overseerr.png', r: 'diamkil', p: 60 },
  ],
};

test.before(() => {
  fs.writeFileSync(icons.INDEX_FILE, JSON.stringify(FIXTURE));
});

test.after(() => {
  fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true });
});

test('an exact name match outranks a more popular partial match', async () => {
  const { results } = await icons.search('plex', 5);
  assert.equal(results[0].name, 'plex');
  assert.equal(results[0].repo, 'linuxserver');
});

test('spacing and hyphens are ignored when matching', async () => {
  for (const query of ['open webui', 'openwebui', 'Open-WebUI', 'OPEN WEBUI']) {
    const { results } = await icons.search(query, 3);
    assert.equal(results[0]?.name, 'open-webui', `query "${query}" should find open-webui`);
  }
});

test('a query with no match returns nothing rather than noise', async () => {
  const { results, total } = await icons.search('zzzznotanapp', 5);
  assert.equal(total, 0);
  assert.deepEqual(results, []);
});

test('the browse view returns curated apps, not raw download rankings', async () => {
  const { results } = await icons.search('', 10);
  const names = results.map((r) => r.name.toLowerCase());
  assert.ok(names.includes('plex'), 'expected plex in the starter set');
  assert.ok(names.includes('jellyfin'), 'expected jellyfin in the starter set');
  // postgresql is the highest-popularity fixture entry but is not a starter app.
  assert.ok(!names.some((n) => n.startsWith('postgresql')), 'database sidecars should not lead');
});

test('the browse view never repeats one icon', async () => {
  const { results } = await icons.search('', 40);
  const urls = results.map((r) => r.icon);
  assert.equal(new Set(urls).size, urls.length);
});

test('deprecated-but-real apps stay searchable', async () => {
  const { results } = await icons.search('overseerr', 3);
  assert.equal(results[0].name, 'Overseerr');
});

test('github blob links are rewritten to raw so they actually render', () => {
  assert.equal(
    icons.normalizeIconUrl('https://github.com/acme/repo/blob/main/icon.png'),
    'https://raw.githubusercontent.com/acme/repo/main/icon.png',
  );
});

test('non-http icon URLs are refused', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAA', '', null]) {
    assert.equal(icons.normalizeIconUrl(bad), null, `expected ${bad} to be refused`);
  }
});

test('ordinary https icon URLs pass through unchanged', () => {
  const url = 'https://raw.githubusercontent.com/linuxserver/x/master/plex.png';
  assert.equal(icons.normalizeIconUrl(url), url);
});

test('uploads must be images', async () => {
  await assert.rejects(
    () => icons.saveUploadedIcon(Buffer.from('<script>alert(1)</script>'), 'text/html'),
    /must be a PNG/i,
  );
});

test('uploads must not be empty', async () => {
  await assert.rejects(() => icons.saveUploadedIcon(Buffer.alloc(0), 'image/png'), /empty/i);
});

test('oversized uploads are refused', async () => {
  await assert.rejects(
    () => icons.saveUploadedIcon(Buffer.alloc(icons.MAX_ICON_BYTES + 1), 'image/png'),
    /larger than/i,
  );
});

test('a valid upload lands in the icon directory', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const saved = await icons.saveUploadedIcon(png, 'image/png');
  assert.match(saved.path, /^\/icons\/[0-9a-f]{16}\.png$/);
  assert.ok(fs.existsSync(path.join(icons.ICON_DIR, path.basename(saved.path))));
});

test('the index status reports what is cached', () => {
  const status = icons.indexStatus();
  assert.equal(status.available, true);
  assert.equal(status.count, FIXTURE.entries.length);
  assert.equal(status.stale, false);
});

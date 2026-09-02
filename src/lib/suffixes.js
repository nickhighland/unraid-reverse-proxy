'use strict';

/**
 * Guidance about domain suffixes.
 *
 * Only `.local` resolves by itself, because mDNS (RFC 6762) is defined for that
 * domain alone. Every other suffix works fine for routing — the proxy matches on
 * the Host header either way — but something has to answer the name lookup, so
 * they need one wildcard record in whatever DNS server the network already uses.
 */

const SUFFIX_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * TLDs where the entire zone is on the HSTS preload list. Browsers refuse plain
 * HTTP for these before a request is ever sent, so using one locally silently
 * breaks everything this proxy does. Mostly Google-operated TLDs.
 */
const HSTS_PRELOADED = new Set([
  'app', 'dev', 'page', 'new', 'foo', 'zip', 'mov', 'boo', 'dad', 'esq', 'prof',
  'phd', 'rsvp', 'channel', 'nexus', 'ing', 'meme', 'day', 'gle', 'google',
  'search', 'android', 'chrome', 'gmail', 'youtube', 'how', 'soy', 'bank',
  'insurance',
]);

const KNOWN = {
  local: {
    resolves: 'mdns',
    label: 'Zero setup',
    note: 'Resolves by itself over mDNS on macOS, iOS, Windows 10+ and most Linux desktops. '
      + 'Android support is inconsistent.',
  },
  'home.arpa': {
    resolves: 'dns',
    label: 'Reserved for home networks',
    note: 'The officially correct choice for a home network (RFC 8375). Guaranteed never to '
      + 'collide with a public domain.',
  },
  internal: {
    resolves: 'dns',
    label: 'Reserved for private use',
    note: 'Reserved by ICANN in 2024 for private networks. Safe and short.',
  },
  lan: {
    resolves: 'dns',
    label: 'Common convention',
    note: 'Widely used and not delegated publicly, though not formally reserved.',
  },
  home: {
    resolves: 'dns',
    label: 'Common convention',
    note: 'Permanently withheld by ICANN after name-collision review, so it is safe in practice.',
  },
  intranet: { resolves: 'dns', label: 'Common convention', note: 'Not delegated publicly.' },
  private: { resolves: 'dns', label: 'Common convention', note: 'Not delegated publicly.' },
  box: { resolves: 'dns', label: 'Common convention', note: 'Not delegated publicly.' },
};

/** Ordered suggestions offered in the settings UI. */
const SUGGESTIONS = ['local', 'home.arpa', 'internal', 'lan', 'home', 'box'];

function validate(raw) {
  const suffix = String(raw || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!suffix) return { ok: false, error: 'Suffix cannot be empty.' };
  if (suffix.length > 63) return { ok: false, error: `"${suffix}" is too long.` };
  if (!SUFFIX_RE.test(suffix)) {
    return {
      ok: false,
      error: `"${suffix}" is not a valid domain suffix. Use letters, numbers and hyphens, `
        + 'with dots between labels — for example "local" or "home.arpa".',
    };
  }
  return { ok: true, suffix };
}

/** Describes one suffix: how it resolves, and any warning worth showing. */
function describe(suffix) {
  const known = KNOWN[suffix];
  const tld = suffix.split('.').pop();
  const info = {
    suffix,
    resolves: known ? known.resolves : 'dns',
    label: known ? known.label : 'Custom',
    note: known ? known.note : 'Needs a DNS record pointing at this proxy.',
    warning: null,
  };

  if (HSTS_PRELOADED.has(tld)) {
    info.warning = `".${tld}" is a real public TLD on the HSTS preload list — browsers force `
      + 'HTTPS on it and will refuse to load these pages over plain HTTP. Pick something else.';
  } else if (!known && !suffix.includes('.')) {
    info.warning = `".${suffix}" is not a reserved private suffix. If it ever becomes a real TLD `
      + 'these names will collide with the public internet. ".internal" or ".home.arpa" are safe.';
  }
  return info;
}

/**
 * Normalises a submitted list: trims, lowercases, dedupes, validates.
 * Returns { ok, error } or { ok, suffixes }.
 */
function validateList(raw) {
  const input = Array.isArray(raw) ? raw : [raw];
  if (!input.length) return { ok: false, error: 'Configure at least one domain suffix.' };
  if (input.length > 6) return { ok: false, error: 'Six domain suffixes is the maximum.' };

  const out = [];
  for (const entry of input) {
    const result = validate(entry);
    if (!result.ok) return result;
    if (!out.includes(result.suffix)) out.push(result.suffix);
  }
  if (!out.length) return { ok: false, error: 'Configure at least one domain suffix.' };
  return { ok: true, suffixes: out };
}

module.exports = { validate, validateList, describe, SUGGESTIONS, HSTS_PRELOADED };

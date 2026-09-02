/* Shared helpers for every page. */

export const BRAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 6h5a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3h5"/>
  <path d="M4 18h5a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3h5"/>
  <circle cx="20" cy="6" r="1.6" fill="#fff"/>
  <circle cx="20" cy="18" r="1.6" fill="#fff"/>
</svg>`;

export const SEARCH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastStack = null;

export function toast(message, kind = '') {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.appendChild(toastStack);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 5200 : 3000);
}

export function initials(name) {
  const words = String(name).trim().split(/[\s\-_]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function statusLabel(status) {
  if (!status) return 'Status unknown';
  if (status.up) return `Online${status.latencyMs != null ? ` · ${status.latencyMs} ms` : ''}`;
  return `Offline${status.error ? ` · ${status.error}` : ''}`;
}

export function mountBrand(container, title, subtitle) {
  container.innerHTML = `
    <div class="brand-mark">${BRAND_SVG}</div>
    <div class="brand-text">
      <h1></h1>
      <p></p>
    </div>`;
  container.querySelector('h1').textContent = title;
  container.querySelector('p').textContent = subtitle;
}

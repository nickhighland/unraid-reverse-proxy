import {
  api, el, initials, mountBrand, statusLabel, SEARCH_SVG,
} from './common.js';

const grid = document.getElementById('grid');
const content = document.getElementById('content');
const search = document.getElementById('search');
const foot = document.getElementById('foot');
const newTabToggle = document.getElementById('newTabToggle');

document.getElementById('searchIcon').outerHTML = SEARCH_SVG;

let services = [];
let session = {};
let openInNewTab = localStorage.getItem('urp:newTab') !== 'false';

function syncToggle() {
  newTabToggle.textContent = openInNewTab ? '↗ New tab' : '→ Same tab';
  newTabToggle.title = openInNewTab
    ? 'Links open in a new tab — click to change'
    : 'Links open in this tab — click to change';
}

newTabToggle.addEventListener('click', () => {
  openInNewTab = !openInNewTab;
  localStorage.setItem('urp:newTab', String(openInNewTab));
  syncToggle();
  render();
});

function tile(service) {
  const icon = service.icon
    ? el('div', { class: 'tile-icon' }, [el('img', { src: service.icon, alt: '', loading: 'lazy' })])
    : el('div', { class: 'tile-icon', text: initials(service.name) });

  const status = service.status
    ? (service.status.up ? 'up' : 'down')
    : 'unknown';

  const body = [
    el('div', { class: 'tile-name', text: service.name }),
    el('div', { class: 'tile-host', text: service.fqdn }),
  ];
  if (service.description) {
    body.push(el('div', { class: 'tile-desc', text: service.description }));
  }

  return el('a', {
    class: 'tile',
    href: service.url,
    style: `--tile-color:${service.color}`,
    target: openInNewTab ? '_blank' : null,
    rel: openInNewTab ? 'noopener' : null,
    'data-name': `${service.name} ${service.fqdn} ${service.description || ''}`.toLowerCase(),
    title: statusLabel(service.status),
  }, [
    icon,
    el('div', { class: 'tile-body' }, body),
    el('span', { class: `dot ${status} tile-status` }),
  ]);
}

function emptyState() {
  return el('div', { class: 'empty' }, [
    el('h3', { text: 'No services yet' }),
    el('p', { text: 'Map your first container to a .local address and it will show up here.' }),
    el('a', { class: 'btn btn-primary', href: '/admin' }, ['Open the admin panel']),
  ]);
}

function noMatches(term) {
  return el('div', { class: 'empty' }, [
    el('h3', { text: 'Nothing matches' }),
    el('p', { text: `No service matches “${term}”.` }),
  ]);
}

function render() {
  const term = search.value.trim().toLowerCase();
  content.replaceChildren();

  if (!services.length) {
    content.appendChild(emptyState());
    return;
  }
  const matches = term
    ? services.filter((s) => `${s.name} ${s.fqdn} ${s.description || ''}`.toLowerCase().includes(term))
    : services;

  if (!matches.length) {
    content.appendChild(noMatches(search.value.trim()));
    return;
  }
  const g = el('div', { class: 'grid' });
  for (const service of matches) g.appendChild(tile(service));
  content.appendChild(g);
}

async function loadServices() {
  const data = await api('/api/services');
  services = data.services || [];
  render();
  const count = services.length;
  foot.textContent = count
    ? `${count} service${count === 1 ? '' : 's'} · reverse proxied on this machine`
    : '';
}

async function refreshStatus() {
  try {
    const { status } = await api('/api/status');
    let changed = false;
    for (const service of services) {
      const next = status[service.id] || null;
      const before = service.status ? service.status.up : null;
      service.status = next;
      if ((next ? next.up : null) !== before) changed = true;
    }
    if (changed) render();
  } catch {
    /* transient; the next tick will retry */
  }
}

search.addEventListener('input', render);
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    search.value = '';
    render();
    search.blur();
  }
  if (event.key === 'Enter') {
    const first = content.querySelector('.tile');
    if (first) first.click();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== search) {
    event.preventDefault();
    search.focus();
    search.select();
  }
});

async function init() {
  syncToggle();
  try {
    session = await api('/api/session');
  } catch {
    session = {};
  }
  const title = session.dashboardTitle || 'Unraid Services';
  document.title = title;
  mountBrand(document.getElementById('brand'), title, 'Reverse proxy · .' + (session.domainSuffix || 'local'));
  if (!session.authenticated) {
    const link = document.getElementById('adminLink');
    link.textContent = 'Sign in';
    link.href = '/login?next=/admin';
  }

  try {
    await loadServices();
  } catch (err) {
    content.replaceChildren(el('div', { class: 'notice error', text: err.message }));
    return;
  }
  setInterval(refreshStatus, 30_000);
}

init();

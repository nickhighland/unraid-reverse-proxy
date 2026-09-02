import {
  api, el, initials, mountBrand, statusLabel, toast, SEARCH_SVG,
} from './common.js';

const content = document.getElementById('content');
const search = document.getElementById('search');
const foot = document.getElementById('foot');
const newTabToggle = document.getElementById('newTabToggle');
const sortSelect = document.getElementById('sortSelect');

document.getElementById('searchIcon').outerHTML = SEARCH_SVG;

const state = {
  services: [],
  categories: [],
  appearance: {},
  sort: 'manual',
  canEdit: false,
};

const UNCATEGORISED = 'Ungrouped';

let openInNewTab = localStorage.getItem('urp:newTab') !== 'false';
const collapsed = new Set(JSON.parse(localStorage.getItem('urp:collapsed') || '[]'));

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

// ---------- appearance ----------

function applyAppearance() {
  const a = state.appearance || {};
  const root = document.documentElement;

  if (a.accent) {
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${a.accent} 14%, transparent)`);
  }
  if (a.theme && a.theme !== 'auto') root.dataset.theme = a.theme;
  else root.removeAttribute('data-theme');
  root.dataset.density = a.density || 'comfortable';
  root.dataset.layout = a.layout || 'grid';
  root.dataset.background = a.background || 'aurora';
}

// ---------- tiles ----------

function tile(service) {
  const a = state.appearance || {};
  const icon = service.icon
    ? el('div', { class: 'tile-icon' }, [el('img', { src: service.icon, alt: '', loading: 'lazy' })])
    : el('div', { class: 'tile-icon', text: initials(service.name) });

  const status = service.status ? (service.status.up ? 'up' : 'down') : 'unknown';

  const body = [el('div', { class: 'tile-name', text: service.name })];
  if (a.showHostnames !== false) {
    body.push(el('div', { class: 'tile-host', text: service.fqdn }));
  }
  if (a.showDescriptions !== false && service.description) {
    body.push(el('div', { class: 'tile-desc', text: service.description }));
  }

  const node = el('a', {
    class: 'tile',
    href: service.url,
    style: `--tile-color:${service.color}`,
    target: openInNewTab ? '_blank' : null,
    rel: openInNewTab ? 'noopener' : null,
    'data-id': service.id,
    draggable: state.canEdit && state.sort === 'manual' ? 'true' : null,
    title: statusLabel(service.status),
  }, [
    icon,
    el('div', { class: 'tile-body' }, body),
    a.showStatus !== false ? el('span', { class: `dot ${status} tile-status` }) : null,
  ]);

  if (state.canEdit && state.sort === 'manual') attachDrag(node, service);
  return node;
}

// ---------- drag to arrange ----------

let dragging = null;

function clearDropHints() {
  for (const n of content.querySelectorAll('.drop-before, .drop-after, .group-drop')) {
    n.classList.remove('drop-before', 'drop-after', 'group-drop');
  }
}

function attachDrag(node, service) {
  node.addEventListener('dragstart', (event) => {
    dragging = service;
    node.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Without this an <a> drag offers its href, which browsers prefer.
    event.dataTransfer.setData('text/plain', service.id);
  });
  node.addEventListener('dragend', () => {
    dragging = null;
    node.classList.remove('dragging');
    clearDropHints();
  });
  node.addEventListener('dragover', (event) => {
    if (!dragging || dragging.id === service.id) return;
    event.preventDefault();
    event.stopPropagation();
    const box = node.getBoundingClientRect();
    const after = (event.clientX - box.left) > box.width / 2;
    node.classList.toggle('drop-after', after);
    node.classList.toggle('drop-before', !after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const after = node.classList.contains('drop-after');
    clearDropHints();
    if (!dragging || dragging.id === service.id) return;
    moveService(dragging, service.category || '', service.id, after);
  });
}

/** A whole group is a drop target too, so empty groups still accept tiles. */
function attachGroupDrop(node, category) {
  node.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    node.classList.add('group-drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('group-drop'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    clearDropHints();
    if (!dragging) return;
    moveService(dragging, category, null, true);
  });
}

async function moveService(moved, category, anchorId, after) {
  const list = state.services.filter((s) => s.id !== moved.id);
  moved.category = category;

  let index;
  if (anchorId) {
    const at = list.findIndex((s) => s.id === anchorId);
    index = at < 0 ? list.length : (after ? at + 1 : at);
  } else {
    // Dropped on a group rather than a tile: append to that group.
    const last = list.map((s) => s.category || '').lastIndexOf(category);
    index = last < 0 ? list.length : last + 1;
  }
  list.splice(index, 0, moved);
  state.services = list;
  render();

  try {
    await api('/api/services/order', {
      method: 'POST',
      body: {
        ids: state.services.map((s) => s.id),
        categories: { [moved.id]: category },
      },
    });
  } catch (err) {
    toast(err.message, 'error');
    load();
  }
}

// ---------- grouping & sorting ----------

function sorted(list) {
  const copy = [...list];
  if (state.sort === 'name') {
    copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else if (state.sort === 'status') {
    const rank = (s) => (s.status ? (s.status.up ? 0 : 1) : 2);
    copy.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }
  return copy;
}

function groupHeading(label, count, key) {
  const isCollapsed = collapsed.has(key);
  const head = el('button', {
    class: `group-head${isCollapsed ? ' collapsed' : ''}`,
    type: 'button',
    'aria-expanded': String(!isCollapsed),
  }, [
    el('span', { class: 'group-caret', text: '▾' }),
    el('span', { class: 'group-name', text: label }),
    el('span', { class: 'group-count', text: String(count) }),
  ]);
  head.addEventListener('click', () => {
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    localStorage.setItem('urp:collapsed', JSON.stringify([...collapsed]));
    render();
  });
  return head;
}

function render() {
  const term = search.value.trim().toLowerCase();
  content.replaceChildren();

  if (!state.services.length) {
    content.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'No services yet' }),
      el('p', { text: 'Map your first container to a .local address and it will show up here.' }),
      el('a', { class: 'btn btn-primary', href: '/admin' }, ['Open the admin panel']),
    ]));
    return;
  }

  const matches = term
    ? state.services.filter((s) => `${s.name} ${s.fqdn} ${s.description || ''} ${s.category || ''}`
      .toLowerCase().includes(term))
    : state.services;

  if (!matches.length) {
    content.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'Nothing matches' }),
      el('p', { text: `No service matches “${search.value.trim()}”.` }),
    ]));
    return;
  }

  // Searching flattens the view — groups get in the way of finding one thing.
  const grouping = state.appearance.groupByCategory !== false && !term;
  if (!grouping) {
    const grid = el('div', { class: 'grid' });
    for (const s of sorted(matches)) grid.appendChild(tile(s));
    content.appendChild(grid);
    return;
  }

  const hasLoose = matches.some((s) => !s.category);
  const order = [...state.categories, ...(hasLoose ? [''] : [])];

  for (const category of order) {
    const inGroup = sorted(matches.filter((s) => (s.category || '') === category));
    if (!inGroup.length) continue;
    const key = category || UNCATEGORISED;

    const section = el('section', { class: 'group' });
    section.appendChild(groupHeading(category || UNCATEGORISED, inGroup.length, key));

    if (!collapsed.has(key)) {
      const grid = el('div', { class: 'grid' });
      for (const s of inGroup) grid.appendChild(tile(s));
      section.appendChild(grid);
    }
    if (state.canEdit && state.sort === 'manual') attachGroupDrop(section, category);
    content.appendChild(section);
  }
}

// ---------- data ----------

async function load() {
  const data = await api('/api/dashboard');
  state.services = data.services || [];
  state.categories = data.categories || [];
  state.appearance = data.appearance || {};
  state.sort = data.sort || 'manual';
  state.canEdit = Boolean(data.canEdit);

  document.title = data.title || 'Services';
  mountBrand(
    document.getElementById('brand'),
    data.title || 'Services',
    state.canEdit ? 'Drag tiles to arrange them' : 'Reverse proxy',
  );

  sortSelect.value = state.sort;
  sortSelect.hidden = false;

  applyAppearance();
  render();

  const n = state.services.length;
  foot.textContent = n ? `${n} service${n === 1 ? '' : 's'}` : '';
}

sortSelect.addEventListener('change', async () => {
  state.sort = sortSelect.value;
  render();
  if (!state.canEdit) return;
  try {
    const current = await api('/api/settings');
    await api('/api/settings', {
      method: 'PUT',
      body: { ...current.settings, dashboardSort: state.sort },
    });
  } catch {
    /* the view already changed; persisting the preference is a nicety */
  }
});

async function refreshStatus() {
  try {
    const { status } = await api('/api/status');
    let changed = false;
    for (const service of state.services) {
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
    const session = await api('/api/session');
    if (!session.authenticated) {
      const link = document.getElementById('adminLink');
      link.textContent = 'Sign in';
      link.href = '/login?next=/admin';
    }
  } catch { /* the dashboard still renders */ }

  try {
    await load();
  } catch (err) {
    content.replaceChildren(el('div', { class: 'notice error', text: err.message }));
    return;
  }
  setInterval(refreshStatus, 30_000);
}

init();

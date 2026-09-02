import {
  api, el, initials, mountBrand, statusLabel, toast,
} from './common.js';

const state = {
  services: [],
  settings: {},
  system: null,
  suffix: 'local',
};

const listEl = document.getElementById('serviceList');
const emptyEl = document.getElementById('serviceEmpty');
const modalRoot = document.getElementById('modalRoot');

// ---------- tabs ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
    if (tab.dataset.tab === 'system') loadSystem();
  });
}

// ---------- service list ----------

function serviceRow(service, index) {
  const icon = service.icon
    ? el('div', { class: 'item-icon' }, [el('img', { src: service.icon, alt: '', loading: 'lazy' })])
    : el('div', { class: 'item-icon', text: initials(service.name) });

  const statusClass = service.status ? (service.status.up ? 'up' : 'down') : 'unknown';

  const title = el('div', { class: 'item-title' }, [
    el('span', { class: `dot ${statusClass}`, title: statusLabel(service.status) }),
    el('strong', { text: service.name }),
    service.enabled ? null : el('span', { class: 'badge off', text: 'disabled' }),
    service.showOnDashboard ? null : el('span', { class: 'badge', text: 'hidden' }),
  ]);

  const route = el('div', { class: 'item-route' }, [
    el('span', { text: service.fqdn }),
    el('span', { class: 'arrow', text: '→' }),
    el('span', { text: `${service.scheme}://${service.host}:${service.port}` }),
  ]);

  const row = el('div', {
    class: `item${service.enabled ? '' : ' disabled'}`,
    'data-id': service.id,
    'data-index': index,
    style: `--item-color:${service.color}`,
    draggable: 'true',
  }, [
    el('span', { class: 'grip', text: '⠿', title: 'Drag to reorder' }),
    icon,
    el('div', { class: 'item-main' }, [title, route]),
    el('div', { class: 'item-actions' }, [
      el('a', {
        class: 'btn btn-sm', href: service.url, target: '_blank', rel: 'noopener', title: 'Open',
      }, ['Open']),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openModal(service) }, ['Edit']),
      el('button', {
        class: 'btn btn-sm btn-danger', type: 'button', onclick: () => removeService(service),
      }, ['Delete']),
    ]),
  ]);

  attachDrag(row);
  return row;
}

function renderServices() {
  listEl.replaceChildren();
  emptyEl.replaceChildren();

  if (!state.services.length) {
    emptyEl.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'Nothing mapped yet' }),
      el('p', { text: 'Add your first container — for example Open WebUI at 192.168.254.254:8080 as openwebui.local.' }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => openModal(null) }, ['+ Add service']),
    ]));
    return;
  }
  state.services.forEach((service, index) => listEl.appendChild(serviceRow(service, index)));
}

// ---------- drag to reorder ----------

let dragId = null;

function attachDrag(row) {
  row.addEventListener('dragstart', (event) => {
    dragId = row.dataset.id;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
  });
  row.addEventListener('dragend', () => {
    dragId = null;
    row.classList.remove('dragging');
    for (const r of listEl.children) r.classList.remove('drop-target');
  });
  row.addEventListener('dragover', (event) => {
    if (!dragId || dragId === row.dataset.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (event) => {
    event.preventDefault();
    row.classList.remove('drop-target');
    if (!dragId || dragId === row.dataset.id) return;
    const from = state.services.findIndex((s) => s.id === dragId);
    const to = state.services.findIndex((s) => s.id === row.dataset.id);
    if (from < 0 || to < 0) return;
    const [moved] = state.services.splice(from, 1);
    state.services.splice(to, 0, moved);
    renderServices();
    try {
      await api('/api/services/order', { method: 'POST', body: { ids: state.services.map((s) => s.id) } });
    } catch (err) {
      toast(err.message, 'error');
      loadServices();
    }
  });
}

// ---------- add / edit modal ----------

function field(label, input, hint) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'label', text: label }),
    input,
    hint ? el('span', { class: 'hint', text: hint }) : null,
  ]);
}

function toggle(id, title, description, checked) {
  return el('label', { class: 'switch' }, [
    el('input', { type: 'checkbox', id, ...(checked ? { checked: 'checked' } : {}) }),
    el('span', { class: 'switch-text' }, [
      el('strong', { text: title }),
      el('small', { text: description }),
    ]),
  ]);
}

function openModal(service) {
  const isEdit = Boolean(service);
  const s = service || {
    name: '', hostname: '', scheme: 'http', host: '', port: '', description: '',
    icon: '', color: '#4f8cff', enabled: true, showOnDashboard: true,
    websockets: true, preserveHost: true, rewriteRedirects: true, insecureTls: false,
  };

  const nameInput = el('input', { class: 'input', id: 'f-name', value: s.name, placeholder: 'Open WebUI' });
  const hostnameInput = el('input', {
    class: 'input', id: 'f-hostname', value: s.hostname, placeholder: 'openwebui', spellcheck: 'false',
  });
  const schemeSelect = el('select', { class: 'select', id: 'f-scheme' }, [
    el('option', { value: 'http', ...(s.scheme === 'http' ? { selected: 'selected' } : {}) }, ['http']),
    el('option', { value: 'https', ...(s.scheme === 'https' ? { selected: 'selected' } : {}) }, ['https']),
  ]);
  const hostInput = el('input', {
    class: 'input', id: 'f-host', value: s.host, placeholder: '192.168.254.254', spellcheck: 'false',
  });
  const portInput = el('input', {
    class: 'input', id: 'f-port', type: 'number', min: '1', max: '65535', value: s.port, placeholder: '8080',
  });
  const descInput = el('input', { class: 'input', id: 'f-desc', value: s.description, placeholder: 'Optional subtitle' });
  const iconInput = el('input', { class: 'input', id: 'f-icon', value: s.icon, placeholder: 'https://…/icon.png' });
  const colorInput = el('input', { type: 'color', id: 'f-color', value: s.color });

  // Typing "192.168.1.5:8080" into the address box should fill the port too.
  hostInput.addEventListener('blur', () => {
    const match = hostInput.value.trim().match(/^(?:https?:\/\/)?([^/:]+):(\d+)/);
    if (match) {
      hostInput.value = match[1];
      if (!portInput.value) portInput.value = match[2];
    }
  });

  // --- icon control -------------------------------------------------------
  const iconPreview = el('div', { class: 'icon-preview' });
  const uploadInput = el('input', { type: 'file', accept: 'image/*', hidden: 'hidden' });

  function paintPreview() {
    const url = iconInput.value.trim();
    iconPreview.replaceChildren(
      url
        ? el('img', { src: url, alt: '', onerror: () => { iconPreview.replaceChildren(el('span', { text: '!' })); } })
        : el('span', { text: initials(nameInput.value || '?') }),
    );
    iconPreview.style.background = url ? 'transparent' : colorInput.value;
  }

  iconInput.addEventListener('input', paintPreview);
  colorInput.addEventListener('input', paintPreview);
  nameInput.addEventListener('input', () => { if (!iconInput.value.trim()) paintPreview(); });

  const browseBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Browse library']);
  browseBtn.addEventListener('click', () => {
    openIconPicker(async (picked) => {
      iconInput.value = picked.icon;
      if (!nameInput.value.trim()) nameInput.value = picked.name;
      paintPreview();
      // Keep a local copy so the tile still renders if the source host goes away.
      try {
        const saved = await api('/api/icons/cache', { method: 'POST', body: { url: picked.icon } });
        iconInput.value = saved.path;
        paintPreview();
      } catch {
        /* offline or blocked — the remote URL still works */
      }
    });
  });

  const uploadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Upload…']);
  uploadBtn.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files[0];
    if (!file) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/icons/upload', {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      iconInput.value = data.path;
      paintPreview();
      toast('Icon uploaded', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      uploadInput.value = '';
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload…';
    }
  });

  const iconControl = el('div', { class: 'icon-control' }, [
    el('div', { class: 'icon-control-top' }, [iconPreview, browseBtn, uploadBtn, uploadInput]),
    iconInput,
  ]);
  paintPreview();

  const errorBox = el('div', { class: 'notice error', hidden: 'hidden' });
  const testResult = el('span', { class: 'hint', style: 'margin:0' });

  const testBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Test connection']);
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.textContent = 'Testing…';
    try {
      const result = await api('/api/test', {
        method: 'POST',
        body: { host: hostInput.value.trim(), port: Number(portInput.value) },
      });
      testResult.textContent = result.up
        ? `✓ Reachable in ${result.latencyMs} ms`
        : `✗ No response (${result.error})`;
      testResult.style.color = result.up ? 'var(--ok)' : 'var(--bad)';
    } catch (err) {
      testResult.textContent = err.message;
      testResult.style.color = 'var(--bad)';
    } finally {
      testBtn.disabled = false;
    }
  });

  const saveBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, [isEdit ? 'Save changes' : 'Add service']);

  const form = el('form', { class: 'modal' }, [
    el('h2', { text: isEdit ? `Edit ${s.name}` : 'Add a service' }),
    el('p', { class: 'sub', text: 'Point a friendly hostname at a container already running on your network.' }),
    errorBox,
    field('Display name', nameInput),
    field('Hostname', el('div', { class: 'suffixed' }, [
      hostnameInput,
      el('span', { class: 'suffix', text: `.${state.suffix}` }),
    ]), 'Letters, numbers and hyphens only.'),
    el('div', { class: 'row' }, [
      el('div', { style: 'flex:0 0 110px' }, [field('Protocol', schemeSelect)]),
      field('Target address', hostInput),
      el('div', { style: 'flex:0 0 110px' }, [field('Port', portInput)]),
    ]),
    el('div', { style: 'display:flex;align-items:center;gap:12px;margin:-4px 0 16px' }, [testBtn, testResult]),
    field('Description', descInput),
    el('div', { class: 'row' }, [
      field('Icon', iconControl, 'Search the Unraid app library, upload your own, or paste a URL.'),
      el('div', { style: 'flex:0 0 130px' }, [
        field('Colour', el('div', { class: 'color-row' }, [colorInput])),
      ]),
    ]),
    el('details', { class: 'advanced' }, [
      el('summary', { text: 'Advanced' }),
      toggle('f-enabled', 'Enabled', 'Route traffic and advertise the hostname.', s.enabled),
      toggle('f-dash', 'Show on dashboard', 'Include this tile on the launch screen.', s.showOnDashboard),
      toggle('f-ws', 'Forward WebSockets', 'Needed for live UIs like Open WebUI, Sonarr and Portainer.', s.websockets),
      toggle('f-preserve', 'Preserve Host header', 'Send the .local name upstream. Turn off if the app misbehaves.', s.preserveHost),
      toggle('f-redir', 'Rewrite redirects', 'Rewrite upstream redirects that point back at its raw IP.', s.rewriteRedirects),
      toggle('f-tls', 'Ignore TLS certificate errors', 'For HTTPS targets using a self-signed certificate.', s.insecureTls),
    ]),
    el('div', { class: 'modal-actions' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, ['Cancel']),
      saveBtn,
    ]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const payload = {
      name: nameInput.value.trim(),
      hostname: hostnameInput.value.trim(),
      scheme: schemeSelect.value,
      host: hostInput.value.trim(),
      port: Number(portInput.value),
      description: descInput.value.trim(),
      icon: iconInput.value.trim(),
      color: colorInput.value,
      enabled: form.querySelector('#f-enabled').checked,
      showOnDashboard: form.querySelector('#f-dash').checked,
      websockets: form.querySelector('#f-ws').checked,
      preserveHost: form.querySelector('#f-preserve').checked,
      rewriteRedirects: form.querySelector('#f-redir').checked,
      insecureTls: form.querySelector('#f-tls').checked,
    };
    saveBtn.disabled = true;
    try {
      if (isEdit) {
        await api(`/api/services/${s.id}`, { method: 'PUT', body: payload });
        toast(`Saved ${payload.name}`, 'ok');
      } else {
        await api('/api/services', { method: 'POST', body: payload });
        toast(`${payload.name} is now at ${payload.hostname}.${state.suffix}`, 'ok');
      }
      closeModal();
      await loadServices();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });

  const backdrop = el('div', { class: 'modal-backdrop' }, [form]);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal();
  });
  modalRoot.replaceChildren(backdrop);
  document.addEventListener('keydown', escClose);
  nameInput.focus();
}

function escClose(event) {
  // The icon picker sits above this modal and owns Escape while it is open.
  if (event.key === 'Escape' && !document.querySelector('.picker-backdrop')) closeModal();
}

function closeModal() {
  modalRoot.replaceChildren();
  document.removeEventListener('keydown', escClose);
}

async function removeService(service) {
  if (!confirm(`Delete "${service.name}"? ${service.fqdn} will stop resolving.`)) return;
  try {
    await api(`/api/services/${service.id}`, { method: 'DELETE' });
    toast(`Deleted ${service.name}`);
    await loadServices();
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('addService').addEventListener('click', () => openModal(null));

// ---------- settings ----------

const settingsFields = {
  dashboardTitle: 'dashboardTitle',
  domainSuffix: 'domainSuffix',
  adminHostname: 'adminHostname',
  advertiseIp: 'advertiseIp',
  healthCheckSeconds: 'healthCheckSeconds',
};

function fillSettings() {
  for (const [key, id] of Object.entries(settingsFields)) {
    document.getElementById(id).value = state.settings[key] ?? '';
  }
  document.getElementById('mdnsEnabled').checked = state.settings.mdnsEnabled !== false;
  document.getElementById('dashboardRequiresLogin').checked = state.settings.dashboardRequiresLogin === true;
  document.getElementById('adminSuffix').textContent = `.${state.settings.domainSuffix}`;
}

document.getElementById('domainSuffix').addEventListener('input', (event) => {
  document.getElementById('adminSuffix').textContent = `.${event.target.value || 'local'}`;
});

document.getElementById('saveSettings').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const notice = document.getElementById('settingsNotice');
  button.disabled = true;
  try {
    const payload = {
      dashboardTitle: document.getElementById('dashboardTitle').value,
      domainSuffix: document.getElementById('domainSuffix').value,
      adminHostname: document.getElementById('adminHostname').value,
      advertiseIp: document.getElementById('advertiseIp').value.trim() || 'auto',
      healthCheckSeconds: Number(document.getElementById('healthCheckSeconds').value),
      mdnsEnabled: document.getElementById('mdnsEnabled').checked,
      dashboardRequiresLogin: document.getElementById('dashboardRequiresLogin').checked,
    };
    const result = await api('/api/settings', { method: 'PUT', body: payload });
    state.settings = result.settings;
    state.suffix = result.settings.domainSuffix;
    fillSettings();
    notice.hidden = true;
    toast('Settings saved', 'ok');
    await loadServices();
  } catch (err) {
    notice.textContent = err.message;
    notice.className = 'notice error';
    notice.hidden = false;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('changePassword').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const notice = document.getElementById('passwordNotice');
  const current = document.getElementById('currentPassword');
  const next = document.getElementById('newPassword');
  button.disabled = true;
  try {
    await api('/api/password', {
      method: 'POST',
      body: { currentPassword: current.value, newPassword: next.value },
    });
    current.value = '';
    next.value = '';
    notice.textContent = 'Password changed. Other sessions have been signed out.';
    notice.className = 'notice ok';
    notice.hidden = false;
  } catch (err) {
    notice.textContent = err.message;
    notice.className = 'notice error';
    notice.hidden = false;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (!confirm('Importing replaces every service currently configured. Continue?')) return;
  try {
    const parsed = JSON.parse(await file.text());
    const result = await api('/api/import', { method: 'POST', body: parsed });
    toast(`Imported ${result.count} service(s)`, 'ok');
    await Promise.all([loadServices(), loadSettings()]);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- system ----------

function metaCard(label, value) {
  return el('dl', { class: 'meta' }, [
    el('dt', { text: label }),
    el('dd', { text: String(value) }),
  ]);
}

async function loadSystem() {
  const grid = document.getElementById('systemGrid');
  const names = document.getElementById('mdnsNames');
  try {
    const info = await api('/api/system');
    state.system = info;
    const uptime = info.uptimeSeconds;
    const pretty = uptime > 3600
      ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
      : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;

    grid.replaceChildren(
      metaCard('Advertised IP', info.advertiseIp),
      metaCard('Auto-detected IP', info.detectedIp),
      metaCard('Listening port', info.httpPort),
      metaCard('mDNS responder', info.mdns.enabled ? (info.mdns.running ? 'running' : 'stopped') : 'disabled'),
      metaCard('Interfaces', info.interfaces.map((i) => `${i.name} ${i.address}`).join(', ') || 'none'),
      metaCard('Config file', info.configFile),
      metaCard('Version', `${info.version} · node ${info.node}`),
      metaCard('Uptime', pretty),
    );

    names.replaceChildren();
    if (!info.mdns.names.length) {
      names.appendChild(el('p', { class: 'hint', text: 'No names are being advertised.' }));
    }
    for (const name of info.mdns.names) {
      names.appendChild(el('div', { class: 'item' }, [
        el('span', { class: 'dot up' }),
        el('div', { class: 'item-main' }, [
          el('div', { class: 'item-route', text: `${name}  →  ${info.advertiseIp}` }),
        ]),
      ]));
    }

    const hint = document.getElementById('advertiseHint');
    hint.textContent = `The address clients are told to connect to. Auto-detected: ${info.detectedIp}.`;

    const banner = document.getElementById('bridgeWarning');
    if (info.bridgeWarning) {
      banner.innerHTML = '';
      banner.appendChild(el('strong', { text: `${info.advertiseIp} is a Docker bridge address. ` }));
      banner.appendChild(document.createTextNode(
        'It only exists inside the server, so .local names will resolve to somewhere nothing on your '
        + 'network can reach. Give this container its own IP: set Network Type to "Custom: br0" with a '
        + 'fixed address outside your DHCP pool, then restart it.',
      ));
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } catch (err) {
    grid.replaceChildren(el('div', { class: 'notice error', text: err.message }));
  }
}

document.getElementById('refreshSystem').addEventListener('click', loadSystem);

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

// ---------- boot ----------

async function loadServices() {
  const data = await api('/api/services');
  state.services = data.services || [];
  renderServices();
  document.getElementById('foot').textContent = `${state.services.length} service(s) configured`;
}

async function loadSettings() {
  const data = await api('/api/settings');
  state.settings = data.settings;
  state.suffix = data.settings.domainSuffix;
  fillSettings();
}

async function init() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) {
      location.href = '/login?next=/admin';
      return;
    }
    mountBrand(document.getElementById('brand'), 'Reverse Proxy', `Signed in as ${session.username}`);
    await Promise.all([loadSettings(), loadServices()]);
    loadSystem();
    setInterval(() => loadServices().catch(() => {}), 30_000);
  } catch (err) {
    if (err.status === 401) location.href = '/login?next=/admin';
    else toast(err.message, 'error');
  }
}


// ---------- icon picker ----------

let pickerDebounce = null;

function openIconPicker(onPick) {
  const searchInput = el('input', {
    class: 'input', type: 'search', placeholder: 'Search 3,700+ Unraid app icons…', autocomplete: 'off',
  });
  const results = el('div', { class: 'icon-grid' });
  const statusLine = el('p', { class: 'hint', style: 'margin:10px 0 0' });

  async function run(query) {
    statusLine.textContent = 'Searching…';
    try {
      const data = await api(`/api/icons?q=${encodeURIComponent(query)}&limit=60`);
      results.replaceChildren();
      if (!data.results.length) {
        statusLine.textContent = query ? `No icons match “${query}”.` : 'No icons available.';
        return;
      }
      for (const item of data.results) {
        const cell = el('button', {
          class: 'icon-cell', type: 'button', title: `${item.name}${item.repo ? ` — ${item.repo}` : ''}`,
        }, [
          el('img', {
            src: item.icon,
            alt: '',
            loading: 'lazy',
            onerror: (event) => { event.target.closest('.icon-cell')?.remove(); },
          }),
          el('span', { class: 'icon-cell-name', text: item.name }),
          el('span', { class: 'icon-cell-repo', text: item.repo || '' }),
        ]);
        cell.addEventListener('click', () => {
          onPick(item);
          closePicker();
        });
        results.appendChild(cell);
      }
      const age = data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : 'unknown';
      statusLine.textContent = `${data.total} match${data.total === 1 ? '' : 'es'} · app list updated ${age}`;
    } catch (err) {
      results.replaceChildren();
      statusLine.textContent = err.message;
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(pickerDebounce);
    pickerDebounce = setTimeout(() => run(searchInput.value.trim()), 180);
  });

  const refreshBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Refresh list']);
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    try {
      const data = await api('/api/icons/refresh', { method: 'POST' });
      toast(`Loaded ${data.count} app icons`, 'ok');
      await run(searchInput.value.trim());
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh list';
    }
  });

  const panel = el('div', { class: 'modal icon-picker' }, [
    el('h2', { text: 'Choose an icon' }),
    el('p', { class: 'sub', text: 'Icons come from the Unraid Community Applications catalogue.' }),
    el('div', { style: 'display:flex;gap:10px;align-items:center' }, [searchInput, refreshBtn]),
    results,
    statusLine,
    el('div', { class: 'modal-actions' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: () => closePicker() }, ['Cancel']),
    ]),
  ]);

  const backdrop = el('div', { class: 'modal-backdrop picker-backdrop' }, [panel]);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closePicker();
  });

  function closePicker() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      closePicker();
    }
  }
  document.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
  searchInput.focus();
  run('');
}

init();

document.addEventListener('DOMContentLoaded', () => {
  showOAuthError();
  loadSettings();
  loadAccounts();
  loadIcsFeeds();

  // Preferences auto-save on change.
  document.getElementById('firstDay').addEventListener('change', saveSettings);
  document.getElementById('defaultView').addEventListener('change', saveSettings);
  document.getElementById('timeFormat').addEventListener('change', saveSettings);
  document.getElementById('showWeekends').addEventListener('change', saveSettings);
  document.getElementById('syncInterval').addEventListener('change', saveSettings);

  // Accounts.
  document.getElementById('ms-connect').onclick = () => (location.href = '/auth/microsoft?return=settings');
  document.getElementById('g-connect').onclick = () => (location.href = '/auth/google?return=settings');
  document.getElementById('ms-disconnect').onclick = () => disconnect('microsoft');
  document.getElementById('g-disconnect').onclick = () => disconnect('google');

  // ICS.
  document.getElementById('ics-form').addEventListener('submit', addIcsFeed);

  // Google calendars.
  document.getElementById('google-cals-save').addEventListener('click', saveGoogleCalendars);
});

// ── Preferences ──

async function loadSettings() {
  const s = await fetch('/api/settings').then((r) => r.json());
  document.getElementById('firstDay').value = String(s.firstDay);
  document.getElementById('defaultView').value = s.defaultView;
  document.getElementById('timeFormat').value = s.timeFormat;
  document.getElementById('showWeekends').checked = s.showWeekends !== false;
  document.getElementById('syncInterval').value = String(s.syncInterval ?? 15);
}

async function saveSettings() {
  const body = {
    firstDay: Number(document.getElementById('firstDay').value),
    defaultView: document.getElementById('defaultView').value,
    timeFormat: document.getElementById('timeFormat').value,
    showWeekends: document.getElementById('showWeekends').checked,
    syncInterval: Number(document.getElementById('syncInterval').value),
  };
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const note = document.getElementById('saved-note');
  note.textContent = '✓ Saved';
  clearTimeout(note._t);
  note._t = setTimeout(() => (note.textContent = ''), 1500);
}

// ── Accounts ──

async function loadAccounts() {
  const me = await fetch('/api/me').then((r) => r.json());
  applyProvider('microsoft', me.configured.microsoft, me.connected.microsoft, {
    statusEl: 'ms-status', connectEl: 'ms-connect', disconnectEl: 'ms-disconnect', defaultLabel: 'Outlook',
  });
  applyProvider('google', me.configured.google, me.connected.google, {
    statusEl: 'g-status', connectEl: 'g-connect', disconnectEl: 'g-disconnect', defaultLabel: 'Google',
  });
  if (me.connected.google) {
    loadGoogleCalendars();
  } else {
    document.getElementById('google-cals-section').classList.add('hidden');
  }
}

function applyProvider(provider, configured, connected, els) {
  const status = document.getElementById(els.statusEl);
  const connectBtn = document.getElementById(els.connectEl);
  const disconnectBtn = document.getElementById(els.disconnectEl);

  if (!configured) {
    status.textContent = `${els.defaultLabel} (not configured — see README)`;
    status.classList.remove('connected');
    connectBtn.disabled = true;
    disconnectBtn.classList.add('hidden');
    return;
  }
  connectBtn.disabled = false;
  if (connected) {
    status.textContent = connected.email || connected.name || els.defaultLabel;
    status.classList.add('connected');
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
  } else {
    status.textContent = els.defaultLabel;
    status.classList.remove('connected');
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }
}

async function disconnect(provider) {
  await fetch(`/logout?provider=${provider}`, { method: 'POST' });
  loadAccounts();
}

// ── Google sub-calendars ──

async function loadGoogleCalendars() {
  const section = document.getElementById('google-cals-section');
  section.classList.remove('hidden');
  try {
    const { calendars } = await fetch('/api/google/calendars').then((r) => r.json());
    const list = document.getElementById('google-cals-list');
    list.innerHTML = '';
    for (const cal of calendars) {
      const li = document.createElement('li');
      li.className = 'gcal-item';
      li.innerHTML = `
        <input type="checkbox" class="gcal-check" ${cal.selected ? 'checked' : ''}
               data-google-id="${esc(cal.googleId)}"
               data-name="${esc(cal.name)}"
               data-color="${esc(cal.backgroundColor)}" />
        <span class="swatch" style="background:${esc(cal.backgroundColor)};width:14px;height:14px;border-radius:3px;flex-shrink:0"></span>
        <span class="gcal-name">${esc(cal.name)}</span>
        <span class="muted" style="font-size:0.78rem">${esc(cal.accessRole)}</span>`;
      list.appendChild(li);
    }
    document.getElementById('google-cals-loading').classList.add('hidden');
    list.classList.remove('hidden');
    document.getElementById('google-cals-save').classList.remove('hidden');
  } catch {
    document.getElementById('google-cals-loading').textContent = 'Failed to load calendars.';
  }
}

async function saveGoogleCalendars() {
  const checks = document.querySelectorAll('.gcal-check:checked');
  const calendars = [...checks].map((c) => ({
    googleId: c.dataset.googleId,
    name: c.dataset.name,
    color: c.dataset.color,
  }));
  const res = await fetch('/api/google/calendars', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendars }),
  });
  if (res.ok) {
    const note = document.getElementById('gcal-saved-note');
    note.textContent = '✓ Saved — reload the main calendar to see changes';
    clearTimeout(note._t);
    note._t = setTimeout(() => (note.textContent = ''), 4000);
  }
}

// ── ICS feeds ──

async function loadIcsFeeds() {
  const { feeds } = await fetch('/api/ics').then((r) => r.json());
  const list = document.getElementById('ics-list');
  list.innerHTML = '';
  if (!feeds.length) {
    list.innerHTML = '<li class="muted">No subscriptions yet.</li>';
    return;
  }
  for (const f of feeds) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="swatch" style="background:${f.color}"></span>
      <span class="ics-name">${esc(f.name)}</span>
      <button class="ics-remove" title="Remove">✕</button>`;
    li.querySelector('.ics-remove').onclick = () => removeIcsFeed(f.id);
    list.appendChild(li);
  }
}

async function addIcsFeed(e) {
  e.preventDefault();
  const url = document.getElementById('ics-url').value.trim();
  const name = document.getElementById('ics-name').value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/ics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name }),
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Could not add ICS feed.');
      return;
    }
    document.getElementById('ics-url').value = '';
    document.getElementById('ics-name').value = '';
    loadIcsFeeds();
  } finally {
    btn.disabled = false;
  }
}

async function removeIcsFeed(id) {
  await fetch(`/api/ics/${id}`, { method: 'DELETE' });
  loadIcsFeeds();
}

// ── Shared helpers ──

function showBanner(msg) {
  const b = document.getElementById('banner');
  b.textContent = '⚠ ' + msg;
  b.classList.remove('hidden');
}

function showOAuthError() {
  const err = new URLSearchParams(location.search).get('error');
  if (err) {
    showBanner(`Login with ${err} failed. Check your credentials and redirect URI.`);
    history.replaceState({}, '', '/settings.html');
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

let calendar;
let dayCal;
let settings = {};
const eventCache = new Map();
const visibility = {};
const staleKeys = new Set();
const refreshingKeys = new Set();
// Once Google's token is rejected, the server clears it, so follow-up requests
// return a clean empty result. Stay sticky so a later empty response can't wipe
// the "reconnect" banner. Reconnecting reloads the page, which resets this.
let googleReauthNeeded = false;

const CACHE_KEY = 'calCache_v2';
const PREFETCH_PAST_DAYS = 14;
const PREFETCH_FUTURE_MONTHS = 6;
let lastSyncedTime = null;
let bgSyncTimer = null;

// State for the create/edit form
let editingEventId = null;  // bare Google event ID (no 'g-' prefix), null when creating
let editingCalId = null;    // calId like 'gcal_primary' of the event being edited
let currentModalEvent = null; // FullCalendar event shown in the detail modal
let writeableCals = [];     // [{ id: 'gcal_primary', name: 'My Calendar' }]

function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.179 ? '#000000' : '#ffffff';
}

// ── Persistent cache ──

function loadPersistedCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.version !== 1) return;
    for (const [key, events] of Object.entries(data.entries || {})) {
      eventCache.set(key, events);
      staleKeys.add(key);
    }
    lastSyncedTime = data.lastSynced || null;
  } catch { /* ignore corrupt cache */ }
}

function savePersistentCache() {
  try {
    const entries = {};
    const dur = (k) => { const sep = k.indexOf('|'); return sep < 0 ? 0 : new Date(k.slice(sep + 1)) - new Date(k.slice(0, sep)); };
    const keys = [...eventCache.keys()].sort((a, b) => dur(b) - dur(a));
    for (const k of keys.slice(0, 12)) entries[k] = eventCache.get(k);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, lastSynced: lastSyncedTime, entries }));
  } catch { /* quota exceeded */ }
}

function updateLastSynced() {
  lastSyncedTime = new Date().toISOString();
  updateLastSyncedDisplay();
  savePersistentCache();
}

function updateLastSyncedDisplay() {
  const el = document.getElementById('last-synced');
  if (!el) return;
  if (!lastSyncedTime) { el.textContent = ''; return; }
  const diffMin = Math.floor((Date.now() - new Date(lastSyncedTime)) / 60000);
  if (diffMin < 1) el.textContent = 'Synced just now';
  else if (diffMin < 60) el.textContent = `Synced ${diffMin}m ago`;
  else {
    const h = Math.floor(diffMin / 60);
    el.textContent = h < 24 ? `Synced ${h}h ago` : `Synced ${new Date(lastSyncedTime).toLocaleDateString()}`;
  }
}

// ── Initialization ──

async function fetchWithLocalCache(url, cacheKey, fallback = null) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch {}
    return data;
  } catch {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {}
    return fallback;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  showOAuthError();
  settings = await fetchWithLocalCache('/api/settings', 'cal_settings_cache') ?? {};
  loadPersistedCache();
  await renderCalendars();
  initCalendar();
  renderStatus();
  setupModals();
  setupJumpTo();
  setupSidebar();
  setupBackgroundSync(settings.syncInterval ?? 15);
  updateLastSyncedDisplay();
  setInterval(updateLastSyncedDisplay, 60000);
  document.getElementById('sync-btn').addEventListener('click', syncNow);
  setupSearch();
  prefetchLargeWindow();
});

// ── Pre-fetch helpers ──

function getPrefetchRange() {
  const start = new Date();
  start.setDate(start.getDate() - PREFETCH_PAST_DAYS);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setMonth(end.getMonth() + PREFETCH_FUTURE_MONTHS + 1);
  end.setDate(0);
  end.setHours(23, 59, 59, 999);
  return { startStr: start.toISOString(), endStr: end.toISOString() };
}

function filterToRange(events, startStr, endStr) {
  const rs = new Date(startStr).getTime();
  const re = new Date(endStr).getTime();
  return events.filter((e) => {
    const es = new Date(e.start).getTime();
    const ee = e.end ? new Date(e.end).getTime() : es + 1;
    return ee > rs && es < re;
  });
}

function findSupersetKey(startStr, endStr) {
  const rs = new Date(startStr).getTime();
  const re = new Date(endStr).getTime();
  for (const key of eventCache.keys()) {
    const sep = key.indexOf('|');
    if (sep < 0) continue;
    if (new Date(key.slice(0, sep)).getTime() <= rs && new Date(key.slice(sep + 1)).getTime() >= re) return key;
  }
  return null;
}

async function prefetchLargeWindow() {
  const { startStr, endStr } = getPrefetchRange();
  const superKey = findSupersetKey(startStr, endStr);
  if (superKey && !staleKeys.has(superKey) && !refreshingKeys.has(superKey)) return;
  await refreshInBackground(`${startStr}|${endStr}`, startStr, endStr);
}

// ── Event loading ──

function isWriteableCal(calId) {
  return writeableCals.some((c) => c.id === calId);
}

// Filter to visible calendars and flag which events may be dragged / resized.
function prepEvents(events) {
  return events
    .filter((e) => visibility[e.calId] !== false)
    .map((e) => ({ ...e, editable: isWriteableCal(e.calId) }));
}

async function loadEvents(info) {
  const key = `${info.startStr}|${info.endStr}`;

  const cached = eventCache.get(key);
  if (cached) {
    if (staleKeys.has(key)) {
      staleKeys.delete(key);
      refreshInBackground(key, info.startStr, info.endStr);
    }
    return prepEvents(cached);
  }

  const superKey = findSupersetKey(info.startStr, info.endStr);
  if (superKey !== null) {
    const subset = filterToRange(eventCache.get(superKey), info.startStr, info.endStr);
    eventCache.set(key, subset);
    if (staleKeys.has(superKey)) {
      staleKeys.delete(superKey);
      const sep = superKey.indexOf('|');
      refreshInBackground(superKey, superKey.slice(0, sep), superKey.slice(sep + 1));
    }
    return prepEvents(subset);
  }

  const all = await fetchFromApi(key, info.startStr, info.endStr);
  return prepEvents(all);
}

// Reflect an /api/events response in the warning banner. The Google reauth state
// is sticky: once flagged, it stays until the page reloads (i.e. after reconnect).
function applyBannerState(data) {
  if (data.googleReauth) {
    googleReauthNeeded = true;
    renderStatus();
  }
  if (googleReauthNeeded) {
    showBanner('Google Calendar token expired.', { href: '/auth/google', text: 'Reconnect Google →' });
  } else if (data.errors?.length) {
    showBanner(data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · '));
  } else {
    hideBanner();
  }
}

async function fetchFromApi(key, startStr, endStr) {
  const params = new URLSearchParams({ start: startStr, end: endStr });
  const data = await fetch(`/api/events?${params}`).then((r) => r.json());
  applyBannerState(data);
  const events = (data.events || []).map((e) => ({
    ...e,
    textColor: contrastColor(e.color || '#666666'),
  }));
  eventCache.set(key, events);
  updateLastSynced();
  return events;
}

async function refreshInBackground(key, startStr, endStr) {
  if (refreshingKeys.has(key)) return;
  refreshingKeys.add(key);
  try {
    const params = new URLSearchParams({ start: startStr, end: endStr });
    const data = await fetch(`/api/events?${params}`).then((r) => r.json());
    applyBannerState(data);
    eventCache.set(key, (data.events || []).map((e) => ({
      ...e,
      textColor: contrastColor(e.color || '#666666'),
    })));
    const rs = new Date(startStr).getTime();
    const re = new Date(endStr).getTime();
    for (const k of [...eventCache.keys()]) {
      if (k === key) continue;
      const sep = k.indexOf('|');
      if (sep < 0) continue;
      if (new Date(k.slice(0, sep)).getTime() >= rs && new Date(k.slice(sep + 1)).getTime() <= re) eventCache.delete(k);
    }
    updateLastSynced();
    if (calendar) calendar.refetchEvents();
    if (dayCal) dayCal.refetchEvents();
  } catch { /* silent failure */ }
  finally { refreshingKeys.delete(key); }
}

// ── Background sync ──

function setupBackgroundSync(intervalMinutes) {
  if (bgSyncTimer) clearInterval(bgSyncTimer);
  bgSyncTimer = null;
  if (!intervalMinutes) return;
  bgSyncTimer = setInterval(() => {
    for (const key of eventCache.keys()) {
      if (!refreshingKeys.has(key)) staleKeys.add(key);
    }
    prefetchLargeWindow();
    if (calendar) calendar.refetchEvents();
    if (dayCal) dayCal.refetchEvents();
  }, intervalMinutes * 60 * 1000);
}

// ── Time format ──

function timeFmt() {
  const hour12 = settings.timeFormat === '12h';
  return { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 };
}

// ── Sidebar drawer (mobile) ──

function setupSidebar() {
  const toggle = document.getElementById('sidebar-toggle');
  const close = document.getElementById('sidebar-close');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar();
  });
  close?.addEventListener('click', closeSidebar);
  backdrop?.addEventListener('click', closeSidebar);
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-backdrop').classList.add('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
}

// ── Calendar initialization ──

function initCalendar() {
  const isMobile = window.innerWidth < 768;
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: settings.defaultView || 'timeGridWeek',
    firstDay: settings.firstDay ?? 1,
    weekends: settings.showWeekends !== false,
    weekNumbers: !isMobile,
    eventTimeFormat: timeFmt(),
    slotLabelFormat: timeFmt(),
    dayHeaderFormat: isMobile ? { weekday: 'short', day: 'numeric' } : undefined,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    allDayText: '',
    height: '100%',
    scrollTime: '05:00:00',
    nowIndicator: true,
    dayMaxEvents: true,
    selectable: true,
    unselectAuto: true,
    editable: true,
    eventDrop: handleEventChange,
    eventResize: handleEventChange,
    events: (info, success, failure) => loadEvents(info).then(success, failure),
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openModal(info.event);
    },
    select: (info) => {
      openEventForm({ start: info.start, end: info.end, allDay: info.allDay });
      calendar.unselect();
    },
    dateClick: (info) => {
      if (calendar.view.type === 'dayGridMonth') {
        openDayModal(info.date);
      } else {
        const end = info.allDay ? info.date : new Date(info.date.getTime() + 3600000);
        openEventForm({ start: info.date, end, allDay: info.allDay });
      }
    },
    datesSet: () => {
      syncJumpToSelectors();
    },
  });
  calendar.render();

  document.getElementById('open-google').addEventListener('click', () => {
    window.open(providerUrl('google'), '_blank', 'noopener');
  });
  document.getElementById('open-outlook').addEventListener('click', () => {
    window.open(providerUrl('outlook'), '_blank', 'noopener');
  });
}

// ── Jump to year / month ──

function setupJumpTo() {
  const monthSel = document.getElementById('jump-month');
  const yearSel = document.getElementById('jump-year');
  if (!monthSel || !yearSel) return;

  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 3; y <= currentYear + 10; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    yearSel.appendChild(opt);
  }
  yearSel.value = currentYear;

  monthSel.addEventListener('change', () =>
    calendar.gotoDate(new Date(parseInt(yearSel.value), parseInt(monthSel.value), 1))
  );
  yearSel.addEventListener('change', () =>
    calendar.gotoDate(new Date(parseInt(yearSel.value), parseInt(monthSel.value), 1))
  );
}

function syncJumpToSelectors() {
  const monthSel = document.getElementById('jump-month');
  const yearSel = document.getElementById('jump-year');
  if (!monthSel || !yearSel || !calendar) return;
  const d = calendar.getDate();
  monthSel.value = d.getMonth();
  yearSel.value = d.getFullYear();
}

// ── Connection chips ──

async function renderStatus() {
  let me;
  try { me = await fetch('/api/me').then((r) => r.json()); } catch { return; }
  const el = document.getElementById('status');
  const chips = [];
  if (me.connected.microsoft)
    chips.push(`<span class="chip"><span class="dot ms"></span>${esc(me.connected.microsoft.email || 'Outlook')}</span>`);
  if (me.connected.google)
    chips.push(`<span class="chip"><span class="dot g"></span>${esc(me.connected.google.email || 'Google')}</span>`);
  el.innerHTML = chips.join('') || '<span class="chip muted">No account connected — open Settings</span>';

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.classList.toggle('hidden', !me.authEnabled);
    logoutBtn.onclick = () => { window.location.href = '/auth/signout'; };
  }
}

// ── Calendars sidebar ──

async function renderCalendars() {
  const { calendars = [] } = await fetchWithLocalCache('/api/calendars', 'cal_calendars_cache', { calendars: [] });
  const list = document.getElementById('calendars');
  list.innerHTML = '';
  writeableCals = [];

  const newBtn = document.getElementById('new-event-btn');

  if (!calendars.length) {
    list.innerHTML = '<li class="muted">No calendars yet — add accounts or ICS feeds in Settings.</li>';
    if (newBtn) newBtn.classList.add('hidden');
    return;
  }

  for (const cal of calendars) {
    visibility[cal.id] = cal.visible;

    if ((cal.kind === 'google-sub' || cal.kind === 'caldav-sub') && cal.writeable) {
      writeableCals.push({ id: cal.id, name: cal.name });
    }

    const li = document.createElement('li');
    li.className = 'cal-item';
    li.innerHTML = `
      <input type="checkbox" class="cal-toggle" ${cal.visible ? 'checked' : ''} title="Show / hide" />
      <input type="color" class="cal-color" value="${cal.color}" title="Change color" />
      <span class="cal-name ${cal.visible ? '' : 'muted'}">${esc(cal.name)}</span>`;

    const showOpenBtn = cal.kind === 'google-sub' || cal.id === 'microsoft'
      || (cal.kind === 'ics' && cal.webCalBase);
    if (showOpenBtn) {
      const btn = document.createElement('button');
      btn.className = 'cal-open-btn';
      btn.textContent = '↗';
      btn.title = `Open in ${(cal.kind === 'google-sub' || cal.webCalBase === 'google') ? 'Google Calendar' : 'Outlook'}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = webCalUrl(cal);
        if (url) window.open(url, '_blank', 'noopener');
      });
      li.appendChild(btn);
    }

    li.querySelector('.cal-toggle').addEventListener('change', (e) =>
      toggleCalendar(cal, e.target.checked, li)
    );
    li.querySelector('.cal-color').addEventListener('change', (e) =>
      recolorCalendar(cal, e.target.value)
    );
    list.appendChild(li);
  }

  if (newBtn) newBtn.classList.toggle('hidden', writeableCals.length === 0);
  populateCalendarSelector();
}

function populateCalendarSelector() {
  const sel = document.getElementById('ef-cal');
  if (!sel) return;
  sel.innerHTML = '';
  for (const cal of writeableCals) {
    const opt = document.createElement('option');
    opt.value = cal.id;
    opt.textContent = cal.name;
    sel.appendChild(opt);
  }
}

function providerUrl(provider) {
  const date = calendar.getDate();
  const viewType = calendar.view.type;
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const view = viewType === 'dayGridMonth' ? 'month' : viewType === 'timeGridDay' ? 'day' : 'week';

  if (provider === 'google') {
    const base = `https://calendar.google.com/calendar/r/${view}`;
    return view === 'month' ? `${base}/${y}/${m}` : `${base}/${y}/${m}/${d}`;
  }
  return `https://outlook.office.com/calendar/view/${view}`;
}

function webCalUrl(cal) {
  const isGoogle = cal.kind === 'google-sub' || cal.webCalBase === 'google';
  return providerUrl(isGoogle ? 'google' : 'outlook');
}

function persistCalendar(cal, patch) {
  if (cal.kind === 'google-sub') {
    return fetch(`/api/google/calendars/${encodeURIComponent(cal.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }
  if (cal.kind === 'caldav-sub') {
    return fetch(`/api/caldav/calendars/${encodeURIComponent(cal.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }
  const url = cal.kind === 'provider' ? `/api/providers/${cal.id}` : `/api/ics/${cal.id}`;
  const method = cal.kind === 'provider' ? 'PUT' : 'PATCH';
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

function toggleCalendar(cal, visible, li) {
  visibility[cal.id] = visible;
  li.querySelector('.cal-name').classList.toggle('muted', !visible);
  persistCalendar(cal, { visible });
  calendar.refetchEvents();
}

function recolorCalendar(cal, color) {
  cal.color = color;
  persistCalendar(cal, { color });
  const tc = contrastColor(color);
  for (const list of eventCache.values()) {
    for (const e of list) if (e.calId === cal.id) { e.color = color; e.textColor = tc; }
  }
  savePersistentCache();
  calendar.refetchEvents();
}

// ── Cache mutation helpers ──

function insertIntoCache(event) {
  if (!event.textColor) event.textColor = contrastColor(event.color || '#666666');
  const es = new Date(event.start).getTime();
  for (const [key, events] of eventCache.entries()) {
    const sep = key.indexOf('|');
    if (sep < 0) continue;
    const rs = new Date(key.slice(0, sep)).getTime();
    const re = new Date(key.slice(sep + 1)).getTime();
    if (es >= rs && es < re) {
      const filtered = events.filter((e) => e.id !== event.id);
      filtered.push(event);
      eventCache.set(key, filtered);
    }
  }
  savePersistentCache();
}

function removeFromCache(eventId) {
  for (const [key, events] of eventCache.entries()) {
    const filtered = events.filter((e) => e.id !== eventId);
    if (filtered.length !== events.length) eventCache.set(key, filtered);
  }
  savePersistentCache();
}

// ── Sync ──

async function syncNow() {
  const btn = document.getElementById('sync-btn');
  btn.classList.add('spinning');
  btn.disabled = true;
  eventCache.clear();
  staleKeys.clear();
  refreshingKeys.clear();
  try { localStorage.removeItem(CACHE_KEY); } catch {}
  await Promise.all([renderCalendars(), renderStatus()]);
  calendar.refetchEvents();
  if (dayCal) dayCal.refetchEvents();
  prefetchLargeWindow();
  setTimeout(() => {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }, 500);
}


// ── Modals setup ──

function setupModals() {
  // Event detail modal
  const eventOverlay = document.getElementById('event-modal');
  const closeDetail = () => eventOverlay.classList.add('hidden');
  document.getElementById('modal-close').onclick = closeDetail;
  eventOverlay.addEventListener('click', (e) => { if (e.target === eventOverlay) closeDetail(); });
  document.getElementById('modal-edit').onclick = () => {
    closeDetail();
    if (currentModalEvent) openEventForm({ event: currentModalEvent });
  };

  // Day-view modal
  const dayOverlay = document.getElementById('day-modal');
  const closeDay = () => dayOverlay.classList.add('hidden');
  document.getElementById('day-modal-close').onclick = closeDay;
  dayOverlay.addEventListener('click', (e) => { if (e.target === dayOverlay) closeDay(); });

  // Event form modal
  const formOverlay = document.getElementById('event-form-modal');
  document.getElementById('ef-close').onclick = closeEventForm;
  document.getElementById('ef-cancel').onclick = closeEventForm;
  formOverlay.addEventListener('click', (e) => { if (e.target === formOverlay) closeEventForm(); });
  document.getElementById('ef-allday').addEventListener('change', () => {
    applyAllDayMode(document.getElementById('ef-allday').checked);
  });
  document.getElementById('ef-form').addEventListener('submit', submitEventForm);
  document.getElementById('ef-delete').addEventListener('click', deleteCurrentEvent);

  // New event button
  const newBtn = document.getElementById('new-event-btn');
  if (newBtn) newBtn.addEventListener('click', () => openEventForm({}));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearch();
      closeDetail();
      closeDay();
      closeEventForm();
    }
  });
}

// ── Event form helpers ──

function applyAllDayMode(allDay) {
  const startInput = document.getElementById('ef-start');
  const endInput = document.getElementById('ef-end');
  if (allDay) {
    const sv = startInput.value ? startInput.value.slice(0, 10) : '';
    const ev = endInput.value ? endInput.value.slice(0, 10) : '';
    startInput.type = 'date';
    endInput.type = 'date';
    startInput.value = sv;
    endInput.value = ev;
  } else {
    const sv = startInput.value ? `${startInput.value}T09:00` : '';
    const ev = endInput.value ? `${endInput.value}T10:00` : '';
    startInput.type = 'datetime-local';
    endInput.type = 'datetime-local';
    startInput.value = sv;
    endInput.value = ev;
  }
}

function openEventForm({ start = null, end = null, allDay = false, event = null }) {
  if (writeableCals.length === 0) {
    showBanner('Connect Google Calendar to create events (or reconnect with full access in Settings).');
    return;
  }

  const isEdit = event !== null;
  document.getElementById('ef-heading').textContent = isEdit ? 'Edit event' : 'New event';
  document.getElementById('ef-delete').classList.toggle('hidden', !isEdit);

  const titleInput = document.getElementById('ef-title');
  const startInput = document.getElementById('ef-start');
  const endInput   = document.getElementById('ef-end');
  const alldayChk  = document.getElementById('ef-allday');
  const calSel     = document.getElementById('ef-cal');
  const locInput   = document.getElementById('ef-loc');
  const descInput  = document.getElementById('ef-desc');

  titleInput.value = '';
  locInput.value   = '';
  descInput.value  = '';

  if (isEdit) {
    const isCaldav = event.extendedProps.calId?.startsWith('cdav_');
    editingEventId = isCaldav ? event.extendedProps.caldavEventUid : bareGoogleId(event.id);
    editingCalId   = event.extendedProps.calId;

    titleInput.value = event.title || '';
    locInput.value   = event.extendedProps.location || '';
    descInput.value  = event.extendedProps.description || '';
    alldayChk.checked = event.allDay;

    if (event.allDay) {
      startInput.type = 'date';
      endInput.type   = 'date';
      startInput.value = toLocalYmd(event.start);
      const inclEnd = event.end ? new Date(event.end.getTime() - 86400000) : event.start;
      endInput.value = toLocalYmd(inclEnd);
    } else {
      startInput.type = 'datetime-local';
      endInput.type   = 'datetime-local';
      startInput.value = toDatetimeLocal(event.start);
      endInput.value   = event.end
        ? toDatetimeLocal(event.end)
        : toDatetimeLocal(new Date(event.start.getTime() + 3600000));
    }
    calSel.value    = editingCalId;
    calSel.disabled = true;
  } else {
    editingEventId = null;
    editingCalId   = null;

    alldayChk.checked = allDay;
    if (allDay) {
      startInput.type = 'date';
      endInput.type   = 'date';
      startInput.value = start ? toLocalYmd(start) : '';
      // For a multi-day drag: end is exclusive, show inclusive last day
      endInput.value = (end && end > start)
        ? toLocalYmd(new Date(end.getTime() - 86400000))
        : (start ? toLocalYmd(start) : '');
    } else {
      startInput.type = 'datetime-local';
      endInput.type   = 'datetime-local';
      startInput.value = start ? toDatetimeLocal(start) : '';
      endInput.value   = end
        ? toDatetimeLocal(end)
        : (start ? toDatetimeLocal(new Date(start.getTime() + 3600000)) : '');
    }
    calSel.disabled = false;
    if (calSel.options.length > 0) calSel.selectedIndex = 0;
  }

  document.getElementById('event-form-modal').classList.remove('hidden');
  titleInput.focus();
}

function closeEventForm() {
  document.getElementById('event-form-modal').classList.add('hidden');
  editingEventId = null;
  editingCalId   = null;
}

async function submitEventForm(e) {
  e.preventDefault();
  const btn = document.getElementById('ef-save');
  btn.disabled = true;

  const allDay     = document.getElementById('ef-allday').checked;
  const startInput = document.getElementById('ef-start');
  const endInput   = document.getElementById('ef-end');
  const calId      = editingCalId || document.getElementById('ef-cal').value;

  let start, end;
  if (allDay) {
    start = startInput.value;
    end   = endInput.value || startInput.value;
  } else {
    start = new Date(startInput.value).toISOString();
    end   = new Date(endInput.value || startInput.value).toISOString();
  }

  const body = {
    calId,
    title: document.getElementById('ef-title').value.trim(),
    start,
    end,
    allDay,
    location:    document.getElementById('ef-loc').value.trim(),
    description: document.getElementById('ef-desc').value.trim(),
  };

  const isCaldav = calId.startsWith('cdav_');

  try {
    let res;
    if (isCaldav) {
      if (editingEventId) {
        res = await fetch(`/api/caldav/events/${encodeURIComponent(editingEventId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch('/api/caldav/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
    } else if (editingEventId) {
      res = await fetch(`/api/google/events/${encodeURIComponent(editingEventId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch('/api/google/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const data = await res.json();
    if (!res.ok) { showBanner(data.error || 'Failed to save event'); return; }

    if (editingEventId) removeFromCache(isCaldav ? `cdav-${editingEventId}` : `g-${editingEventId}`);
    if (data.event) insertIntoCache(data.event);
    closeEventForm();
    calendar.refetchEvents();
    if (dayCal) dayCal.refetchEvents();
  } catch (err) {
    showBanner('Error saving event: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// Shared handler for drag-move (eventDrop) and edge-resize (eventResize).
// Only writeable Google / CalDAV events are draggable (gated via per-event `editable`).
async function handleEventChange(info) {
  const ev = info.event;
  const calId = ev.extendedProps.calId;
  if (!isWriteableCal(calId)) { info.revert(); return; }

  const isCaldav = calId.startsWith('cdav_');
  const eventId = isCaldav ? ev.extendedProps.caldavEventUid : bareGoogleId(ev.id);

  let start, end;
  if (ev.allDay) {
    start = toLocalYmd(ev.start);
    // FullCalendar's end is exclusive; the server expects an inclusive last day (matches the edit form).
    const inclEnd = ev.end ? new Date(ev.end.getTime() - 86400000) : ev.start;
    end = toLocalYmd(inclEnd);
  } else {
    start = ev.start.toISOString();
    end   = (ev.end || new Date(ev.start.getTime() + 3600000)).toISOString();
  }

  const body = {
    calId,
    title: ev.title,
    start,
    end,
    allDay: ev.allDay,
    location:    ev.extendedProps.location || '',
    description: ev.extendedProps.description || '',
  };

  const url = isCaldav
    ? `/api/caldav/events/${encodeURIComponent(eventId)}`
    : `/api/google/events/${encodeURIComponent(eventId)}`;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { showBanner(data.error || 'Failed to update event'); info.revert(); return; }

    removeFromCache(isCaldav ? `cdav-${eventId}` : `g-${eventId}`);
    if (data.event) insertIntoCache(data.event);
    if (calendar) calendar.refetchEvents();
    if (dayCal) dayCal.refetchEvents();
  } catch (err) {
    showBanner('Error updating event: ' + err.message);
    info.revert();
  }
}

async function deleteCurrentEvent() {
  const title = document.getElementById('ef-title').value || 'this event';
  if (!confirm(`Delete "${title}"?`)) return;

  const btn = document.getElementById('ef-delete');
  btn.disabled = true;
  const isCaldavDel = editingCalId?.startsWith('cdav_');
  try {
    let res;
    if (isCaldavDel) {
      res = await fetch(
        `/api/caldav/events/${encodeURIComponent(editingEventId)}?calId=${encodeURIComponent(editingCalId)}`,
        { method: 'DELETE' }
      );
    } else {
      res = await fetch(
        `/api/google/events/${encodeURIComponent(editingEventId)}?calId=${encodeURIComponent(editingCalId)}`,
        { method: 'DELETE' }
      );
    }
    const data = await res.json();
    if (!res.ok) { showBanner(data.error || 'Failed to delete event'); return; }

    removeFromCache(isCaldavDel ? `cdav-${editingEventId}` : `g-${editingEventId}`);
    closeEventForm();
    calendar.refetchEvents();
    if (dayCal) dayCal.refetchEvents();
  } catch (err) {
    showBanner('Error deleting event: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Day-view modal ──

function openDayModal(date) {
  const overlay = document.getElementById('day-modal');
  document.getElementById('day-modal-title').textContent = date.toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  overlay.classList.remove('hidden');

  if (!dayCal) {
    dayCal = new FullCalendar.Calendar(document.getElementById('day-calendar'), {
      initialView: 'timeGridDay',
      initialDate: date,
      headerToolbar: false,
      allDaySlot: true,
      nowIndicator: true,
      height: 460,
      eventTimeFormat: timeFmt(),
      slotLabelFormat: timeFmt(),
      selectable: true,
      editable: true,
      eventDrop: handleEventChange,
      eventResize: handleEventChange,
      events: (info, success, failure) => loadEvents(info).then(success, failure),
      eventClick: (info) => {
        info.jsEvent.preventDefault();
        overlay.classList.add('hidden');
        openModal(info.event);
      },
      select: (info) => {
        overlay.classList.add('hidden');
        openEventForm({ start: info.start, end: info.end, allDay: info.allDay });
        dayCal.unselect();
      },
      dateClick: (info) => {
        overlay.classList.add('hidden');
        const end = info.allDay ? info.date : new Date(info.date.getTime() + 3600000);
        openEventForm({ start: info.date, end, allDay: info.allDay });
      },
    });
    dayCal.render();
  } else {
    dayCal.gotoDate(date);
    dayCal.refetchEvents();
  }
  setTimeout(() => {
    dayCal.updateSize();
    dayCal.scrollToTime({ hours: Math.max(0, new Date().getHours() - 1) });
  }, 0);
}

// ── Event detail modal ──

function openModal(event) {
  currentModalEvent = event;
  const p = event.extendedProps;
  const color = event.backgroundColor || p.color || '#666';
  document.getElementById('modal-title').textContent = event.title;
  document.getElementById('modal-cal').innerHTML =
    `<span class="swatch" style="background:${color}"></span> ${esc(p.source || '')}`;
  document.getElementById('modal-time').textContent = formatEventTime(event);

  const locEl = document.getElementById('modal-location');
  locEl.textContent = p.location ? `📍 ${p.location}` : '';
  locEl.classList.toggle('hidden', !p.location);

  const descEl = document.getElementById('modal-description');
  descEl.textContent = p.description || '';
  descEl.classList.toggle('hidden', !p.description);

  const openEl = document.getElementById('modal-open');
  if (p.originalUrl) {
    openEl.href = p.originalUrl;
    openEl.classList.remove('hidden');
  } else {
    openEl.classList.add('hidden');
  }

  // Show Edit button for any writeable calendar (Google or CalDAV)
  const isWriteable = p.calId && writeableCals.some((c) => c.id === p.calId);
  document.getElementById('modal-edit').classList.toggle('hidden', !isWriteable);

  document.getElementById('event-modal').classList.remove('hidden');
}

function formatEventTime(event) {
  const dOpts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  const tOpts = timeFmt();
  if (event.allDay) {
    const start = event.start;
    const end = event.end ? new Date(event.end.getTime() - 86400000) : null;
    if (!end || end.toDateString() === start.toDateString())
      return start.toLocaleDateString([], dOpts) + ' · All day';
    return `${start.toLocaleDateString([], dOpts)} – ${end.toLocaleDateString([], dOpts)} · All day`;
  }
  const start = event.start;
  const end = event.end;
  const startStr = start.toLocaleDateString([], dOpts) + ', ' + start.toLocaleTimeString([], tOpts);
  if (!end) return startStr;
  const sameDay = start.toDateString() === end.toDateString();
  const endStr = sameDay
    ? end.toLocaleTimeString([], tOpts)
    : end.toLocaleDateString([], dOpts) + ', ' + end.toLocaleTimeString([], tOpts);
  return `${startStr} – ${endStr}`;
}

// ── Date/time helpers ──

function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalYmd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function bareGoogleId(fcId) {
  return fcId.startsWith('g-') ? fcId.slice(2) : fcId;
}

// ── Helpers ──

// `link` (optional) appends a clickable action, e.g. { href, text }. Built via DOM
// nodes rather than innerHTML so message/error text is never interpreted as markup.
function showBanner(msg, link) {
  const b = document.getElementById('banner');
  b.textContent = '⚠ ' + msg;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    a.className = 'banner-link';
    b.append(' ', a);
  }
  b.classList.remove('hidden');
}
function hideBanner() {
  document.getElementById('banner').classList.add('hidden');
}
function showOAuthError() {
  const err = new URLSearchParams(location.search).get('error');
  if (err) {
    showBanner(`Login with ${err} failed. Check your credentials and redirect URI.`);
    history.replaceState({}, '', '/');
  }
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Search ──

const QUICK_JUMPS = [
  { label: 'Today',      key: 'today' },
  { label: 'This week',  key: 'this week' },
  { label: 'Next week',  key: 'next week' },
  { label: 'This month', key: 'this month' },
  { label: 'Next month', key: 'next month' },
];

let searchSelIdx = -1;

function setupSearch() {
  const overlay = document.getElementById('search-modal');
  const input = document.getElementById('search-input');

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      openSearch();
    }
  });

  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('keydown', (e) => {
    const items = document.querySelectorAll('#search-results .search-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchSelIdx = Math.min(searchSelIdx + 1, items.length - 1);
      highlightSearch(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchSelIdx = Math.max(searchSelIdx - 1, 0);
      highlightSearch(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = document.querySelector('#search-results .search-item.selected');
      if (sel) sel.click();
    }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSearch(); });
}

function openSearch() {
  const overlay = document.getElementById('search-modal');
  const input = document.getElementById('search-input');
  overlay.classList.remove('hidden');
  input.value = '';
  searchSelIdx = -1;
  input.focus();
  runSearch('');
}

function closeSearch() {
  document.getElementById('search-modal').classList.add('hidden');
}

function highlightSearch(items) {
  items.forEach((el, i) => el.classList.toggle('selected', i === searchSelIdx));
  items[searchSelIdx]?.scrollIntoView({ block: 'nearest' });
}

function makeJumpItem(label, date) {
  const li = document.createElement('li');
  li.className = 'search-item search-item-date';
  const dateLabel = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  li.innerHTML = `
    <span class="search-item-icon">📅</span>
    <span class="search-item-content">
      <span class="search-item-title">${esc(label)}</span>
      <span class="search-item-meta">${esc(dateLabel)}</span>
    </span>`;
  li.addEventListener('click', () => { calendar.gotoDate(date); closeSearch(); });
  return li;
}

function runSearch(raw) {
  const query = raw.trim();
  const results = document.getElementById('search-results');
  results.innerHTML = '';
  searchSelIdx = -1;

  if (!query) {
    for (const { label, key } of QUICK_JUMPS) {
      const date = parseSearchDate(key);
      if (date) results.appendChild(makeJumpItem(label, date));
    }
    if (results.children.length > 0) {
      searchSelIdx = 0;
      results.children[0].classList.add('selected');
    }
    return;
  }

  // Date-jump result
  const date = parseSearchDate(query);
  if (date) {
    const label = date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    results.appendChild(makeJumpItem(`Jump to ${label}`, date));
  }

  // Event search (min 2 chars)
  if (query.length >= 2) {
    const q = query.toLowerCase();
    const seen = new Set();
    const matches = [];
    for (const events of eventCache.values()) {
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (
          (e.title || '').toLowerCase().includes(q) ||
          (e.description || e.extendedProps?.description || '').toLowerCase().includes(q) ||
          (e.location || e.extendedProps?.location || '').toLowerCase().includes(q) ||
          (e.source || e.extendedProps?.source || '').toLowerCase().includes(q)
        ) {
          matches.push(e);
        }
      }
    }
    const now = new Date();
    const upcoming = matches.filter(e => new Date(e.start) >= now).sort((a, b) => new Date(a.start) - new Date(b.start));
    const past = matches.filter(e => new Date(e.start) < now).sort((a, b) => new Date(b.start) - new Date(a.start));

    const appendEventItem = (e) => {
      const li = document.createElement('li');
      li.className = 'search-item search-item-event';
      const color = e.color || '#888';
      const startDate = new Date(e.start);
      const dateStr = startDate.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      const timeStr = e.allDay ? 'All day' : startDate.toLocaleTimeString([], timeFmt());
      li.innerHTML = `
        <span class="search-dot" style="background:${color}"></span>
        <span class="search-item-content">
          <span class="search-item-title">${esc(e.title || '(no title)')}</span>
          <span class="search-item-meta">${esc(dateStr)} · ${timeStr}${e.source ? ' · ' + esc(e.source) : ''}</span>
        </span>`;
      li.addEventListener('click', () => { closeSearch(); openRawEventModal(e, new Date(e.start)); });
      results.appendChild(li);
    };

    if (upcoming.length > 0 || past.length > 0) {
      if (date) {
        const sep = document.createElement('li');
        sep.className = 'search-divider';
        results.appendChild(sep);
      }
      upcoming.slice(0, 50).forEach(appendEventItem);
      if (past.length > 0) {
        const label = document.createElement('li');
        label.className = 'search-section-label';
        label.textContent = 'Past events';
        results.appendChild(label);
        past.slice(0, 50).forEach(appendEventItem);
      }
    }
  }

  const first = results.querySelector('.search-item');
  if (first) {
    searchSelIdx = 0;
    first.classList.add('selected');
  } else if (query.length >= 2) {
    const li = document.createElement('li');
    li.className = 'search-empty';
    li.textContent = 'No results';
    results.appendChild(li);
  }
}

function openRawEventModal(raw, startDate) {
  calendar.gotoDate(startDate);
  openModal({
    id: raw.id,
    title: raw.title,
    start: new Date(raw.start),
    end: raw.end ? new Date(raw.end) : null,
    allDay: !!raw.allDay,
    backgroundColor: raw.color,
    extendedProps: {
      color: raw.color,
      source: raw.source,
      calId: raw.calId,
      location: raw.location,
      description: raw.description,
      originalUrl: raw.originalUrl,
      caldavEventUid: raw.caldavEventUid,
    },
  });
}

function parseSearchDate(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const clone = () => new Date(today);

  if (q === 'today') return clone();
  if (q === 'tomorrow') { const d = clone(); d.setDate(d.getDate() + 1); return d; }
  if (q === 'yesterday') { const d = clone(); d.setDate(d.getDate() - 1); return d; }
  if (q === 'this week') {
    const d = clone(); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d;
  }
  if (q === 'next week') {
    const d = clone();
    const diff = ((8 - d.getDay()) % 7) || 7;
    d.setDate(d.getDate() + diff); return d;
  }
  if (q === 'last week') {
    const d = clone(); d.setDate(d.getDate() - (d.getDay() + 6) % 7 - 7); return d;
  }
  if (q === 'this month') return new Date(today.getFullYear(), today.getMonth(), 1);
  if (q === 'next month') return new Date(today.getFullYear(), today.getMonth() + 1, 1);
  if (q === 'last month') return new Date(today.getFullYear(), today.getMonth() - 1, 1);
  if (q === 'this year') return new Date(today.getFullYear(), 0, 1);
  if (q === 'next year') return new Date(today.getFullYear() + 1, 0, 1);
  if (q === 'last year') return new Date(today.getFullYear() - 1, 0, 1);

  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const MONTHS_S = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const DAYS_S = ['sun','mon','tue','wed','thu','fri','sat'];

  const getMonth = (s) => { const i = MONTHS.indexOf(s); return i >= 0 ? i : MONTHS_S.indexOf(s); };
  const getDay = (s) => { const i = DAYS.indexOf(s); return i >= 0 ? i : DAYS_S.indexOf(s); };

  // next/last [weekday]: "next monday", "last friday"
  const mRel = q.match(/^(next|last)\s+(\w+)$/);
  if (mRel) {
    const dow = getDay(mRel[2]);
    if (dow >= 0) {
      const d = clone();
      if (mRel[1] === 'next') {
        const diff = ((dow - d.getDay() + 7) % 7) || 7;
        d.setDate(d.getDate() + diff);
      } else {
        const diff = ((d.getDay() - dow + 7) % 7) || 7;
        d.setDate(d.getDate() - diff);
      }
      return d;
    }
  }

  // [month] [year]: "june 2026"
  const mMY = q.match(/^(\w+)\s+(\d{4})$/);
  if (mMY) {
    const mi = getMonth(mMY[1]);
    const yr = parseInt(mMY[2]);
    if (mi >= 0 && yr >= 1900 && yr <= 2100) return new Date(yr, mi, 1);
  }

  // [day] [month] [year?]: "15 june" or "15 june 2026"
  const mDM = q.match(/^(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?$/);
  if (mDM) {
    const day = parseInt(mDM[1]);
    const mi = getMonth(mDM[2]);
    const yr = mDM[3] ? parseInt(mDM[3]) : today.getFullYear();
    if (mi >= 0 && day >= 1 && day <= 31) return new Date(yr, mi, day);
  }

  // [month] [day] [year?]: "june 15" or "june 15 2026"
  const mMD = q.match(/^(\w+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (mMD) {
    const mi = getMonth(mMD[1]);
    const day = parseInt(mMD[2]);
    const yr = mMD[3] ? parseInt(mMD[3]) : today.getFullYear();
    if (mi >= 0 && day >= 1 && day <= 31) return new Date(yr, mi, day);
  }

  // ISO date: "2026-06-15"
  const mISO = q.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mISO) {
    const d = new Date(parseInt(mISO[1]), parseInt(mISO[2]) - 1, parseInt(mISO[3]));
    if (!isNaN(d)) return d;
  }

  // ISO month: "2026-06"
  const mISOm = q.match(/^(\d{4})-(\d{2})$/);
  if (mISOm) return new Date(parseInt(mISOm[1]), parseInt(mISOm[2]) - 1, 1);

  // Year: "2026"
  const mYear = q.match(/^(\d{4})$/);
  if (mYear) {
    const yr = parseInt(mYear[1]);
    if (yr >= 1900 && yr <= 2100) return new Date(yr, 0, 1);
  }

  // Just a weekday name: "monday" → next occurrence
  const dayOnly = getDay(q);
  if (dayOnly >= 0) {
    const d = clone();
    const diff = ((dayOnly - d.getDay() + 7) % 7) || 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Just a month name: "june" → 1st of that month this/next year
  const monthOnly = getMonth(q);
  if (monthOnly >= 0) {
    const yr = today.getMonth() <= monthOnly ? today.getFullYear() : today.getFullYear() + 1;
    return new Date(yr, monthOnly, 1);
  }

  return null;
}

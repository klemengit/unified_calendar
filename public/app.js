let calendar;
let dayCal;
let settings = {};
const eventCache = new Map();
const visibility = {};
const staleKeys = new Set();
const refreshingKeys = new Set();

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

document.addEventListener('DOMContentLoaded', async () => {
  showOAuthError();
  settings = await fetch('/api/settings').then((r) => r.json());
  loadPersistedCache();
  await renderCalendars();
  initCalendar();
  renderStatus();
  setupZoom();
  setupModals();
  setupJumpTo();
  setupBackgroundSync(settings.syncInterval ?? 15);
  updateLastSyncedDisplay();
  setInterval(updateLastSyncedDisplay, 60000);
  document.getElementById('sync-btn').addEventListener('click', syncNow);
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

async function loadEvents(info) {
  const key = `${info.startStr}|${info.endStr}`;

  const cached = eventCache.get(key);
  if (cached) {
    if (staleKeys.has(key)) {
      staleKeys.delete(key);
      refreshInBackground(key, info.startStr, info.endStr);
    }
    return cached.filter((e) => visibility[e.calId] !== false);
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
    return subset.filter((e) => visibility[e.calId] !== false);
  }

  const all = await fetchFromApi(key, info.startStr, info.endStr);
  return all.filter((e) => visibility[e.calId] !== false);
}

async function fetchFromApi(key, startStr, endStr) {
  const params = new URLSearchParams({ start: startStr, end: endStr });
  const data = await fetch(`/api/events?${params}`).then((r) => r.json());
  if (data.errors?.length) showBanner(data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · '));
  else hideBanner();
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
    if (data.errors?.length) showBanner(data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · '));
    else hideBanner();
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

// ── Calendar initialization ──

function initCalendar() {
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: settings.defaultView || 'timeGridWeek',
    firstDay: settings.firstDay ?? 1,
    weekends: settings.showWeekends !== false,
    weekNumbers: true,
    eventTimeFormat: timeFmt(),
    slotLabelFormat: timeFmt(),
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    contentHeight: 'auto',
    nowIndicator: true,
    dayMaxEvents: true,
    selectable: true,
    unselectAuto: true,
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
      applyZoom();
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
  const me = await fetch('/api/me').then((r) => r.json());
  const el = document.getElementById('status');
  const chips = [];
  if (me.connected.microsoft)
    chips.push(`<span class="chip"><span class="dot ms"></span>${esc(me.connected.microsoft.email || 'Outlook')}</span>`);
  if (me.connected.google)
    chips.push(`<span class="chip"><span class="dot g"></span>${esc(me.connected.google.email || 'Google')}</span>`);
  el.innerHTML = chips.join('') || '<span class="chip muted">No account connected — open Settings</span>';
}

// ── Calendars sidebar ──

async function renderCalendars() {
  const { calendars } = await fetch('/api/calendars').then((r) => r.json());
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

// ── Ctrl + scroll zoom ──

const SLOT_MIN = 14, SLOT_MAX = 90;
let slotPx = parseInt(localStorage.getItem('slotPx') || '0', 10) || 0;
let lastContentHeight;
let zoomScheduled = false;

function applyZoom() {
  if (!calendar) return;
  const isTime = calendar.view.type.startsWith('timeGrid');
  let target = 'auto';
  if (isTime && slotPx) {
    const rows = document.querySelectorAll('#calendar .fc-timegrid-slots tr').length || 48;
    target = rows * slotPx;
  }
  if (target !== lastContentHeight) {
    lastContentHeight = target;
    calendar.setOption('contentHeight', target);
  }
}

function setupZoom() {
  applyZoom();
  document.getElementById('calendar').addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!calendar.view.type.startsWith('timeGrid')) return;
      e.preventDefault();
      const base = slotPx || 24;
      slotPx = Math.min(SLOT_MAX, Math.max(SLOT_MIN, base + (e.deltaY < 0 ? 6 : -6)));
      localStorage.setItem('slotPx', String(slotPx));
      if (!zoomScheduled) {
        zoomScheduled = true;
        requestAnimationFrame(() => { zoomScheduled = false; applyZoom(); });
      }
    },
    { passive: false }
  );
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

function showBanner(msg) {
  const b = document.getElementById('banner');
  b.textContent = '⚠ ' + msg;
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

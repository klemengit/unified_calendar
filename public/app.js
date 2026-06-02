let calendar;
let dayCal;
let settings = {};
const eventCache = new Map(); // "startStr|endStr" -> events[]
const visibility = {}; // calId -> boolean (false = hidden)
const staleKeys = new Set(); // keys loaded from localStorage that need background refresh
const refreshingKeys = new Set(); // keys currently being background-refreshed

const CACHE_KEY = 'calCache_v1';
const PREFETCH_PAST_DAYS = 14;
const PREFETCH_FUTURE_MONTHS = 6;
let lastSyncedTime = null;
let bgSyncTimer = null;

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
    // Sort by range duration descending so the large pre-fetch block is always saved first
    const dur = (k) => { const sep = k.indexOf('|'); return sep < 0 ? 0 : new Date(k.slice(sep + 1)) - new Date(k.slice(0, sep)); };
    const keys = [...eventCache.keys()].sort((a, b) => dur(b) - dur(a));
    for (const k of keys.slice(0, 12)) entries[k] = eventCache.get(k);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, lastSynced: lastSyncedTime, entries }));
  } catch { /* quota exceeded — ignore */ }
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
  // Populate cache from localStorage before first render so FullCalendar gets
  // cached data immediately on load, then background-refreshes stale entries.
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
  end.setDate(0); // last day of the 6th future month
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

  // Exact cache hit
  const cached = eventCache.get(key);
  if (cached) {
    if (staleKeys.has(key)) {
      staleKeys.delete(key);
      refreshInBackground(key, info.startStr, info.endStr);
    }
    return cached.filter((e) => visibility[e.calId] !== false);
  }

  // Superset hit — derive subset instantly without a network request
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

  // Nothing cached — fetch from API
  const all = await fetchFromApi(key, info.startStr, info.endStr);
  return all.filter((e) => visibility[e.calId] !== false);
}

async function fetchFromApi(key, startStr, endStr) {
  const params = new URLSearchParams({ start: startStr, end: endStr });
  const data = await fetch(`/api/events?${params}`).then((r) => r.json());
  if (data.errors?.length) showBanner(data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · '));
  else hideBanner();
  const events = data.events || [];
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
    eventCache.set(key, data.events || []);
    // Invalidate derived subset entries so they're re-derived from fresh data on next access
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
    // Re-fetch the large window; refetchEvents is called when it completes
    prefetchLargeWindow();
    // Also immediately refetch current view in case it falls outside the pre-fetch window
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
    events: (info, success, failure) => loadEvents(info).then(success, failure),
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openModal(info.event);
    },
    dateClick: (info) => {
      if (calendar.view.type === 'dayGridMonth') openDayModal(info.date);
    },
    datesSet: () => {
      applyZoom();
      syncJumpToSelectors();
    },
  });
  calendar.render();
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

// ── Connection chips (read-only) ──

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

// ── Calendars sidebar: per-calendar color + show/hide ──

async function renderCalendars() {
  const { calendars } = await fetch('/api/calendars').then((r) => r.json());
  const list = document.getElementById('calendars');
  list.innerHTML = '';
  if (!calendars.length) {
    list.innerHTML = '<li class="muted">No calendars yet — add accounts or ICS feeds in Settings.</li>';
    return;
  }
  for (const cal of calendars) {
    visibility[cal.id] = cal.visible;
    const li = document.createElement('li');
    li.className = 'cal-item';
    li.innerHTML = `
      <input type="checkbox" class="cal-toggle" ${cal.visible ? 'checked' : ''} title="Show / hide" />
      <input type="color" class="cal-color" value="${cal.color}" title="Change color" />
      <span class="cal-name ${cal.visible ? '' : 'muted'}">${esc(cal.name)}</span>`;

    if (hasWebCal(cal)) {
      const link = document.createElement('a');
      link.className = 'cal-link';
      link.textContent = '↗';
      link.title = 'Open in web calendar';
      link.target = '_blank';
      link.rel = 'noopener';
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = webCalUrl(cal);
        if (url) { e.preventDefault(); window.open(url, '_blank'); }
      });
      li.appendChild(link);
    }

    li.querySelector('.cal-toggle').addEventListener('change', (e) =>
      toggleCalendar(cal, e.target.checked, li)
    );
    li.querySelector('.cal-color').addEventListener('change', (e) =>
      recolorCalendar(cal, e.target.value)
    );
    list.appendChild(li);
  }
}

function hasWebCal(cal) {
  return cal.id === 'google' || cal.id === 'microsoft' || !!cal.webCalBase;
}

function webCalUrl(cal) {
  const date = calendar.getDate();
  const viewType = calendar.view.type;
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const view = viewType === 'dayGridMonth' ? 'month' : viewType === 'timeGridDay' ? 'day' : 'week';

  const isGoogle = cal.id === 'google' || cal.webCalBase === 'google';
  const isOutlook = cal.id === 'microsoft' || cal.webCalBase === 'outlook';

  if (isGoogle) {
    const base = `https://calendar.google.com/calendar/r/${view}`;
    return view === 'month' ? `${base}/${y}/${m}` : `${base}/${y}/${m}/${d}`;
  }
  if (isOutlook) return `https://outlook.office.com/calendar/view/${view}`;
  return null;
}

function persistCalendar(cal, patch) {
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
  for (const list of eventCache.values()) {
    for (const e of list) if (e.calId === cal.id) e.color = color;
  }
  savePersistentCache();
  calendar.refetchEvents();
}

// ── Sync: clear cache and pull fresh data ──

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

// ── Ctrl + scroll to zoom time slots (week/day views) ──

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

// ── Modals (event details + day view) ──

function setupModals() {
  const eventOverlay = document.getElementById('event-modal');
  const dayOverlay = document.getElementById('day-modal');
  const closeEvent = () => eventOverlay.classList.add('hidden');
  const closeDay = () => dayOverlay.classList.add('hidden');

  document.getElementById('modal-close').onclick = closeEvent;
  document.getElementById('day-modal-close').onclick = closeDay;
  eventOverlay.addEventListener('click', (e) => { if (e.target === eventOverlay) closeEvent(); });
  dayOverlay.addEventListener('click', (e) => { if (e.target === dayOverlay) closeDay(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeEvent(); closeDay(); }
  });
}

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
      events: (info, success, failure) => loadEvents(info).then(success, failure),
      eventClick: (info) => {
        info.jsEvent.preventDefault();
        openModal(info.event);
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

function openModal(event) {
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
  const originalUrl = event.extendedProps.originalUrl;
  if (originalUrl) {
    openEl.href = originalUrl;
    openEl.classList.remove('hidden');
  } else {
    openEl.classList.add('hidden');
  }

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

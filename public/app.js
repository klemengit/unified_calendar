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
const CAL_PICKS_KEY = 'calPicks_v1';
const LAST_VIEW_KEY = 'cal_last_view';
const SIDEBAR_STATE_KEY = 'cal_sidebar';
const PREFETCH_PAST_DAYS = 14;
const PREFETCH_FUTURE_MONTHS = 6;
let lastSyncedTime = null;
let bgSyncTimer = null;

// State for the create/edit form
let editingEventId = null;  // bare Google event ID (no 'g-' prefix), null when creating
let editingCalId = null;    // calId like 'gcal_primary' of the event being edited
let currentModalEvent = null; // FullCalendar event shown in the detail modal
let writeableCals = [];     // [{ id: 'gcal_primary', name: 'My Calendar' }]
// Whether the event being edited came with its guest list. Events cached before
// guest support did not, and then the field must not be taken as "no guests".
let editingGuestsKnown = false;

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
  applyBodyAttributes();
  reconcileTheme();
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

// Best-effort offline fallback: merge events from every cached window that overlaps
// the requested range (deduped by event id), then clip to range. Used when the
// network is unreachable and no single cached window covers the view.
function collectFromCache(startStr, endStr) {
  const rs = new Date(startStr).getTime();
  const re = new Date(endStr).getTime();
  const byId = new Map();
  for (const [key, events] of eventCache) {
    const sep = key.indexOf('|');
    if (sep < 0) continue;
    const ks = new Date(key.slice(0, sep)).getTime();
    const ke = new Date(key.slice(sep + 1)).getTime();
    if (ke <= rs || ks >= re) continue; // no overlap with requested range
    for (const e of events) byId.set(e.id, e);
  }
  return filterToRange([...byId.values()], startStr, endStr);
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

  try {
    const all = await fetchFromApi(key, info.startStr, info.endStr);
    return prepEvents(all);
  } catch {
    // Server itself unreachable and this range was never cached: show whatever
    // overlapping cached events we have rather than erroring the view.
    showBanner(OFFLINE_BANNER);
    return prepEvents(collectFromCache(info.startStr, info.endStr));
  }
}

const OFFLINE_BANNER = 'Offline — showing cached events. They will refresh when you reconnect.';

// The app server runs locally, so /api/events still returns 200 when the machine is
// offline — only the server's upstream provider fetches fail (DNS / connection
// errors). Detect that case so we keep cached events instead of overwriting them
// with an empty result and showing a wall of getaddrinfo errors.
const NETWORK_ERR = /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|getaddrinfo|socket hang up|network/i;
function isOfflineResponse(data) {
  if (navigator.onLine === false) return true;
  const errs = data.errors || [];
  return errs.length > 0
    && !(data.events && data.events.length)
    && errs.every((e) => NETWORK_ERR.test(e.message || ''));
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
  if (isOfflineResponse(data)) {
    // Don't cache the empty result — fall back to overlapping cached events.
    showBanner(OFFLINE_BANNER);
    return collectFromCache(startStr, endStr);
  }
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
    if (isOfflineResponse(data)) {
      // Keep the existing cache rather than replacing good events with nothing.
      showBanner(OFFLINE_BANNER);
      return;
    }
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

// ── Sidebar ──
//
// One ☰ button toggles body.sidebar-collapsed, which shrinks the sidebar to
// that button alone. Wide screens dock the open sidebar beside the calendar
// and remember the choice. At SIDEBAR_DRAWER_QUERY widths it opens as a drawer
// over the calendar instead, and always starts closed.

const SIDEBAR_DRAWER_QUERY = '(max-width: 1280px)';

function isDrawerWidth() {
  return window.matchMedia?.(SIDEBAR_DRAWER_QUERY).matches ?? false;
}

function storedSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_STATE_KEY) === 'collapsed'; } catch { return false; }
}

function applySidebarCollapsed(collapsed, { persist = true } = {}) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);

  const btn = document.getElementById('sidebar-toggle');
  if (btn) {
    btn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
    btn.setAttribute('aria-expanded', String(!collapsed));
  }

  if (persist && !isDrawerWidth()) {
    try { localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? 'collapsed' : 'expanded'); } catch { /* private mode, quota, etc. */ }
  }

}

function setupSidebar() {
  applySidebarCollapsed(isDrawerWidth() || storedSidebarCollapsed(), { persist: false });

  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    applySidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  });
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => applySidebarCollapsed(true));

  // Crossing into drawer widths closes the sidebar; crossing back restores the
  // docked state the user last chose.
  window.matchMedia?.(SIDEBAR_DRAWER_QUERY).addEventListener?.('change', (e) => {
    applySidebarCollapsed(e.matches || storedSidebarCollapsed(), { persist: false });
  });
}

// ── Body / theme attributes ──
//
// data-spent, data-density and data-today-hl drive CSS purely (visibility of
// .day-spent etc. is decided in styles.css, not here) — this just mirrors
// settings onto <body> so it stays in sync whenever settings are (re)loaded.

function applyBodyAttributes() {
  document.body.dataset.spent = settings.spentDays ?? 'dim';
  document.body.dataset.density = settings.compactDensity ?? 'emphasised';
  document.body.dataset.todayHl = settings.highlightToday === false ? 'off' : 'on';
  document.body.dataset.weekends = settings.weekends ?? 'tint';
}

// Resolves settings.theme ('system' | 'light' | 'dark') to a concrete value.
function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// data-theme on <html> must always be concrete. Written to localStorage so the
// inline boot script in index.html's <head> can apply it before first paint on
// the next load, without waiting on settings to arrive.
function applyTheme(concrete) {
  document.documentElement.dataset.theme = concrete;
  try { localStorage.setItem('cal_theme', concrete); } catch { /* private mode, quota, etc. */ }
}

// Reconciles the pre-paint boot guess (localStorage / matchMedia only) against
// the authoritative settings.theme once settings have loaded. While the theme
// is 'system', also tracks live OS theme changes.
let systemThemeQuery = null;
function reconcileTheme() {
  applyTheme(resolveTheme(settings.theme));
  if (systemThemeQuery) systemThemeQuery.onchange = null;
  if (settings.theme === 'system' && window.matchMedia) {
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemThemeQuery.onchange = (e) => applyTheme(e.matches ? 'dark' : 'light');
  } else {
    systemThemeQuery = null;
  }
}

// ── Calendar initialization ──

// Canonical view order (must match src/store.js VIEW_IDS / CONTRACT.md §2). The
// header toolbar's right slot is always built in this order regardless of the
// order settings.enabledViews happens to list them in.
const VIEW_ORDER = ['timeGridDay', 'timeGridWeek', 'dayGridMonth', 'multiMonth2', 'multiMonth4', 'multiMonthYear', 'listMonth'];

// Builds the headerToolbar "right" button list from settings.enabledViews,
// preserving VIEW_ORDER, so unchecking a view in Settings removes its button.
// Falls back to the full canonical list when the setting is missing or empty.
function buildToolbarRight(enabledViews) {
  const enabled = Array.isArray(enabledViews) && enabledViews.length ? enabledViews : VIEW_ORDER;
  const ordered = VIEW_ORDER.filter((id) => enabled.includes(id));
  return (ordered.length ? ordered : VIEW_ORDER).join(',');
}

// Strictly-before-today (local midnight) test shared by dayCellClassNames.
function isSpentDate(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

// Shared by both calendar instances (main + day-detail modal) so styling stays
// consistent: 'evt-important' for ids the user flagged, 'evt-past' for events
// that have already ended.
function eventClassNames(arg) {
  const classes = [];
  if (Array.isArray(settings.importantEvents) && settings.importantEvents.includes(arg.event.id))
    classes.push('evt-important');
  const end = arg.event.end || arg.event.start;
  if (end && end < new Date()) classes.push('evt-past');
  return classes;
}

// Toggles .is-compact on the calendar root while the active view is any multiMonth* view.
function updateCompactClass(viewType) {
  document.getElementById('calendar')?.classList.toggle('is-compact', viewType.startsWith('multiMonth'));
}

// Resolves the view to open on load: the last view the user was on (from
// localStorage), if it's still enabled; otherwise the "Default view" setting;
// otherwise the hard-coded fallback. Read once at calendar init.
function resolveInitialView() {
  const enabled = Array.isArray(settings.enabledViews) && settings.enabledViews.length
    ? settings.enabledViews
    : VIEW_ORDER;
  let stored;
  try { stored = localStorage.getItem(LAST_VIEW_KEY); } catch { /* private mode, quota, etc. */ }
  if (stored && enabled.includes(stored)) return stored;
  return settings.defaultView || 'timeGridWeek';
}

// ── Important-event day markers (data-imp) ──
//
// styles.css renders a "★N" marker from data-imp in narrow (multi-month) day
// cells when there isn't room for event titles/chips. This just maintains the
// count; no styling here (CONTRACT2 §4c).

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Local-midnight-to-local-midnight day keys an event's chip occupies in the day
// grid: all days from the start date up to (but excluding) the end date, at day
// granularity — matching FullCalendar's own all-day/multi-day slicing, including
// its convention that an end time of exactly local midnight excludes that day.
function eventDateKeys(ev) {
  const start = ev.start;
  if (!start) return [];
  const end = ev.end || start;
  const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const endIsMidnight = end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0;
  if (endDate > startDate && endIsMidnight) endDate.setDate(endDate.getDate() - 1);
  else if (endDate < startDate) endDate = startDate;
  const keys = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    keys.push(dateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

// Recomputes data-imp="N" on every .fc-daygrid-day cell from the currently
// rendered events, clearing stale values first. Called from both eventsSet and
// datesSet, since either can change which cells/events are current.
function updateImportantDayCounts() {
  const root = document.getElementById('calendar');
  if (!root) return;
  root
    .querySelectorAll('.fc-daygrid-day[data-imp], .fc-daygrid-day-events[data-imp]')
    .forEach((el) => el.removeAttribute('data-imp'));
  if (!calendar || !Array.isArray(settings.importantEvents) || !settings.importantEvents.length) return;
  const counts = {};
  for (const ev of calendar.getEvents()) {
    if (!settings.importantEvents.includes(ev.id)) continue;
    for (const key of eventDateKeys(ev)) counts[key] = (counts[key] || 0) + 1;
  }
  for (const [key, n] of Object.entries(counts)) {
    const cell = root.querySelector(`.fc-daygrid-day[data-date="${key}"]`);
    if (!cell) continue;
    cell.setAttribute('data-imp', String(n));
    // The cell itself is the container query's container, and a container query
    // can only style its DESCENDANTS — so the "★N" marker has to hang off the
    // inner frame. attr() only reads the element it sits on, so mirror it there.
    cell.querySelector('.fc-daygrid-day-events')?.setAttribute('data-imp', String(n));
  }
}

function initCalendar() {
  const isMobile = window.innerWidth < 768;
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: resolveInitialView(),
    firstDay: settings.firstDay ?? 1,
    weekends: settings.showWeekends !== false,
    weekNumbers: !isMobile,
    eventTimeFormat: timeFmt(),
    slotLabelFormat: timeFmt(),
    dayHeaderFormat: isMobile ? { weekday: 'short', day: 'numeric' } : undefined,
    views: {
      timeGridDay: { buttonText: 'Day' },
      timeGridWeek: { buttonText: 'Week' },
      dayGridMonth: { buttonText: 'Month' },
      // Generic multiMonth type + duration — there is no multiMonthCount option.
      // dateIncrement keeps prev/next stepping by one month while still
      // *showing* 2 or 4 (duration is unchanged — CONTRACT2 §4a).
      multiMonth2: { type: 'multiMonth', duration: { months: 2 }, dateIncrement: { months: 1 }, multiMonthMaxColumns: 2, buttonText: '2 mo' },
      multiMonth4: { type: 'multiMonth', duration: { months: 4 }, dateIncrement: { months: 1 }, multiMonthMaxColumns: 2, buttonText: '4 mo' },
      multiMonthYear: { buttonText: 'Year' },
      listMonth: { buttonText: 'Agenda' },
    },
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: buildToolbarRight(settings.enabledViews),
    },
    allDayText: '',
    height: '100%',
    scrollTime: '05:00:00',
    nowIndicator: true,
    dayMaxEvents: true,
    selectable: true,
    unselectAuto: true,
    editable: true,
    dayCellClassNames: (arg) => (isSpentDate(arg.date) ? ['day-spent'] : []),
    eventClassNames,
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
    datesSet: (arg) => {
      syncJumpToSelectors();
      updateCompactClass(arg.view.type);
      try { localStorage.setItem(LAST_VIEW_KEY, arg.view.type); } catch { /* private mode, quota, etc. */ }
      updateImportantDayCounts();
    },
    eventsSet: () => {
      updateImportantDayCounts();
    },
  });
  calendar.render();

  // FullCalendar only re-measures on window resize. The sidebar sliding open or
  // shut resizes it without one.
  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => calendar.updateSize());
  }).observe(document.getElementById('calendar'));

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
      writeableCals.push({ id: cal.id, name: cal.name, accountId: cal.accountId });
    }

    const li = document.createElement('li');
    li.className = 'cal-item';
    // Exposes the calendar's color to CSS so the rail-mode swatch (.sidebar.is-rail
    // .cal-toggle, styled by styles.css) can render without a JS-CSS name coupling.
    li.style.setProperty('--cal-color', cal.color);
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

// ── Calendar picker ordering ──
//
// The form's calendar dropdown is ordered by how often each calendar has been
// chosen for a new event, most-used first, so the usual target sits on top and
// is preselected. Ties break on the most recently picked, then on the order the
// server sent, so one use is enough to move a calendar up.

function loadCalPicks() {
  try { return JSON.parse(localStorage.getItem(CAL_PICKS_KEY)) || {}; } catch { return {}; }
}

function recordCalPick(calId) {
  if (!calId) return;
  const picks = loadCalPicks();
  const prev = picks[calId] || { count: 0, last: 0 };
  picks[calId] = { count: prev.count + 1, last: Date.now() };
  try { localStorage.setItem(CAL_PICKS_KEY, JSON.stringify(picks)); } catch {}
  populateCalendarSelector();
}

function calendarsByUse() {
  const picks = loadCalPicks();
  const rank = (c) => picks[c.id] || { count: 0, last: 0 };
  // Array#sort is stable, so untouched calendars keep their server order.
  return [...writeableCals].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return rb.count - ra.count || rb.last - ra.last;
  });
}

// `only` narrows the list, e.g. to the calendars a CalDAV event can move between.
function populateCalendarSelector(only = () => true) {
  const sel = document.getElementById('ef-cal');
  if (!sel) return;
  sel.innerHTML = '';
  for (const cal of calendarsByUse().filter(only)) {
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
  const stopSpinner = () => setTimeout(() => {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }, 500);

  // Don't sync while offline — clearing/refetching would only replace good cached
  // events with nothing. Keep what we have and tell the user.
  if (navigator.onLine === false) {
    showBanner('Offline — can’t sync now. Showing cached events; they will refresh when you reconnect.');
    stopSpinner();
    return;
  }

  // Refresh in place rather than clearing up front: refreshInBackground replaces a
  // range only when a fresh response arrives and silently keeps the old data on
  // failure, so a mid-sync network drop or server error never wipes the cache.
  const ranges = [...eventCache.keys()]
    .map((key) => {
      const sep = key.indexOf('|');
      return sep < 0 ? null : { key, start: key.slice(0, sep), end: key.slice(sep + 1) };
    })
    .filter(Boolean);
  refreshingKeys.clear();
  await Promise.all([renderCalendars(), renderStatus()]);
  await Promise.all(ranges.map((r) => refreshInBackground(r.key, r.start, r.end)));
  prefetchLargeWindow();
  if (calendar) calendar.refetchEvents();
  if (dayCal) dayCal.refetchEvents();
  stopSpinner();
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
  document.getElementById('modal-important').onclick = () => { toggleImportant(); };

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
  document.getElementById('ef-cal').addEventListener('change', syncGuestsField);
  document.getElementById('ef-form').addEventListener('submit', submitEventForm);
  document.getElementById('ef-delete').addEventListener('click', deleteCurrentEvent);
  setupFormKeyboardFlow();

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

// Tab moves through the form one field at a time. Left to the browser, Tab
// walks the internal segments of a date input (day, month, year, hour, minute)
// before leaving it, so Tab is handled here for the two date fields. Reaching a
// date field from the keyboard also opens the native picker.
function setupFormKeyboardFlow() {
  const order = ['ef-title', 'ef-allday', 'ef-start', 'ef-end', 'ef-cal', 'ef-guests', 'ef-loc', 'ef-desc'];
  let viaKeyboard = false;
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') viaKeyboard = true; }, true);
  document.addEventListener('mousedown', () => { viaKeyboard = false; }, true);

  // The calendar select is disabled while editing, so skip over it.
  const neighbour = (id, back) => {
    let i = order.indexOf(id);
    for (;;) {
      i += back ? -1 : 1;
      if (i < 0 || i >= order.length) return null;
      const el = document.getElementById(order[i]);
      if (el && !el.disabled) return el;
    }
  };

  for (const id of ['ef-start', 'ef-end']) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const next = neighbour(id, e.shiftKey);
      if (!next) return;
      e.preventDefault();
      next.focus();
    });
    input.addEventListener('focus', () => {
      if (!viaKeyboard) return;
      // showPicker() needs a recent user gesture, which the Tab keypress
      // provides; it throws rather than no-ops when that has expired.
      try { input.showPicker?.(); } catch {}
    });
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
  const guestInput = document.getElementById('ef-guests');

  titleInput.value = '';
  locInput.value   = '';
  descInput.value  = '';
  guestInput.value = '';
  editingGuestsKnown = !isEdit;

  if (isEdit) {
    const isCaldav = event.extendedProps.calId?.startsWith('cdav_');
    editingEventId = isCaldav ? event.extendedProps.caldavEventUid : bareGoogleId(event.id);
    editingCalId   = event.extendedProps.calId;

    titleInput.value = event.title || '';
    locInput.value   = event.extendedProps.location || '';
    descInput.value  = event.extendedProps.description || '';
    const guests = event.extendedProps.attendees;
    editingGuestsKnown = Array.isArray(guests);
    if (editingGuestsKnown) {
      guestInput.value = guests.filter((a) => !a.organizer).map((a) => a.email).join(', ');
    }
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
    // A CalDAV event can move to any other calendar of its account (the server
    // MOVEs it); Google events stay where they are.
    if (isCaldav) {
      const accountId = writeableCals.find((c) => c.id === editingCalId)?.accountId;
      populateCalendarSelector((c) => c.id.startsWith('cdav_') && c.accountId === accountId);
    } else {
      populateCalendarSelector();
    }
    calSel.value    = editingCalId;
    calSel.disabled = !isCaldav || calSel.options.length < 2;
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
    populateCalendarSelector();
    calSel.disabled = false;
    if (calSel.options.length > 0) calSel.selectedIndex = 0;
  }

  syncGuestsField();
  document.getElementById('event-form-modal').classList.remove('hidden');
  titleInput.focus();
}

// Only Google calendars can invite anyone: a CalDAV write is a plain file PUT
// with no scheduling behind it, so an address typed there would reach no one.
function syncGuestsField() {
  const calSel = document.getElementById('ef-cal');
  const input = document.getElementById('ef-guests');
  const hint = document.getElementById('ef-guests-hint');
  const calId = editingCalId || calSel.value || '';
  const canInvite = calId.startsWith('gcal_');
  input.disabled = !canInvite;
  document.getElementById('ef-guests-field').classList.toggle('hidden', !canInvite && !input.value);
  hint.textContent = canInvite
    ? 'Guests get an email invitation and the event lands in their own calendar.'
    : 'This calendar cannot send invitations.';
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
  const calSelValue = document.getElementById('ef-cal').value;
  const calId      = editingCalId?.startsWith('cdav_') ? calSelValue : (editingCalId || calSelValue);

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
  if (isCaldav && editingEventId) body.fromCalId = editingCalId;

  // Send the guest list only when it is meaningful: leaving the key out tells
  // the server to keep whatever guests the event already has.
  const guests = document.getElementById('ef-guests').value.trim();
  if (!isCaldav && (editingGuestsKnown || guests)) {
    body.attendees = guests ? guests.split(/[,;\s]+/).filter(Boolean) : [];
  }

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

    if (!editingEventId) recordCalPick(calId);
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
      eventClassNames,
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

  renderLocation(document.getElementById('modal-location'), p.location);
  renderGuests(document.getElementById('modal-guests'), p.attendees);
  renderDescription(document.getElementById('modal-description'), p.description);

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

  updateImportantButton();

  document.getElementById('event-modal').classList.remove('hidden');
}

// ── Manual important flag ──

function isImportant(eventId) {
  return Array.isArray(settings.importantEvents) && settings.importantEvents.includes(eventId);
}

function updateImportantButton() {
  const btn = document.getElementById('modal-important');
  if (!btn || !currentModalEvent) return;
  btn.textContent = isImportant(currentModalEvent.id) ? '☆ Unmark important' : '★ Mark important';
}

// Flips the current modal event's important flag and refetches (cache-only — no
// network round trip, since the range is already cached) so .evt-important picks
// up immediately on both calendar instances.
// Saved one id at a time through POST /api/settings/important, never as a whole
// array: this page's list is a page-load snapshot, and saving all of it would
// wipe out every star made in the bar widget meanwhile. The server answers with
// the authoritative list, which is how those widget stars reach this page.
async function toggleImportant() {
  if (!currentModalEvent) return;
  const id = currentModalEvent.id;
  const list = Array.isArray(settings.importantEvents) ? settings.importantEvents.slice() : [];
  const idx = list.indexOf(id);
  const important = idx < 0;
  if (idx >= 0) list.splice(idx, 1); else list.push(id);
  settings.importantEvents = list;
  updateImportantButton();
  calendar?.refetchEvents();
  dayCal?.refetchEvents();
  try {
    const res = await fetch('/api/settings/important', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, important }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    if (!Array.isArray(saved.importantEvents)) return;
    const known = new Set(list);
    const changed =
      saved.importantEvents.length !== list.length ||
      saved.importantEvents.some((x) => !known.has(x));
    settings.importantEvents = saved.importantEvents;
    // Only re-render when the server knew something this page did not.
    if (changed) {
      updateImportantButton();
      calendar?.refetchEvents();
      dayCal?.refetchEvents();
    }
  } catch { /* local state already updated; next load will reconcile */ }
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
// ── Description rendering ──
//
// Descriptions arrive as HTML (Google, and Outlook-derived ICS feeds) or as
// plain text (most ICS/CalDAV feeds). HTML is rebuilt against a tag allowlist
// before it touches the DOM; plain text is linkified. Either way the result is
// real markup, so links are clickable and formatting survives.

const DESC_ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CAPTION', 'CODE', 'DD', 'DIV', 'DL', 'DT',
  'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'LI', 'OL', 'P', 'PRE',
  'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);
// Dropped along with their contents. IMG is in here on purpose: remote images
// in calendar bodies are usually tracking pixels or broken mail assets.
const DESC_DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
  'SELECT', 'TEXTAREA', 'LINK', 'META', 'TITLE', 'SVG', 'IMG', 'VIDEO', 'AUDIO',
]);
// Anything else (FONT, O:P, custom mail tags) is unwrapped: contents kept, tag dropped.
const SAFE_URL_SCHEME = /^(?:https?:|mailto:|tel:)/i;
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+|[^\s<>"'@,;]+@[^\s<>"'@,;]+\.[a-z]{2,}/gi;

// Deliberately keyed to known tag names: a description saying "arrive <5 min
// late>" is text, not markup, and must not be fed through the sanitizer.
const HTML_TAG_RE = new RegExp(
  '</?(?:a|b|i|u|s|em|strong|p|div|span|br|hr|ul|ol|li|dl|dt|dd|table|thead'
  + '|tbody|tfoot|tr|td|th|h[1-6]|blockquote|pre|code|img|font|small|sub|sup'
  + '|caption|center|figure|section|article|o:p)(?:\\s[^>]*)?/?>', 'i');

function looksLikeHtml(s) {
  return HTML_TAG_RE.test(s);
}

// Strip markup down to readable text — used for search matching.
function descPlainText(s) {
  const v = s || '';
  if (!looksLikeHtml(v)) return v;
  return new DOMParser().parseFromString(v, 'text/html').body.textContent || '';
}

function decodeEntities(s) {
  if (!/&(?:[a-z]+|#\d+);/i.test(s)) return s;
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

function makeLink(href, label) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}

// Append text to `out`, turning bare URLs and email addresses into links.
function appendLinkedText(text, out) {
  let cursor = 0;
  BARE_URL_RE.lastIndex = 0;
  let m;
  while ((m = BARE_URL_RE.exec(text))) {
    // Trailing punctuation is nearly always sentence punctuation, not URL.
    const match = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
    if (!match) { BARE_URL_RE.lastIndex = m.index + m[0].length; continue; }
    if (m.index > cursor) out.appendChild(document.createTextNode(text.slice(cursor, m.index)));
    let href;
    if (/^https?:\/\//i.test(match)) href = match;
    else if (/^www\./i.test(match)) href = `https://${match}`;
    else href = `mailto:${match}`;
    out.appendChild(makeLink(href, match));
    cursor = m.index + match.length;
    BARE_URL_RE.lastIndex = cursor;
  }
  if (cursor < text.length) out.appendChild(document.createTextNode(text.slice(cursor)));
}

// Copy `src`'s children into `dest`, keeping only allowlisted tags/attributes.
function sanitizeInto(src, dest, insideLink) {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (insideLink) dest.appendChild(document.createTextNode(child.nodeValue));
      else appendLinkedText(child.nodeValue, dest);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toUpperCase();
    if (DESC_DROP_TAGS.has(tag)) continue;
    if (!DESC_ALLOWED_TAGS.has(tag)) { sanitizeInto(child, dest, insideLink); continue; }

    if (tag === 'A') {
      const href = (child.getAttribute('href') || '').trim();
      // javascript:/data: hrefs lose the anchor but keep the text.
      if (!SAFE_URL_SCHEME.test(href)) { sanitizeInto(child, dest, insideLink); continue; }
      const a = makeLink(href, '');
      const title = child.getAttribute('title');
      if (title) a.title = title;
      sanitizeInto(child, a, true);
      if (!a.textContent.trim()) a.textContent = href;
      dest.appendChild(a);
      continue;
    }

    const el = document.createElement(tag);
    if (tag === 'TD' || tag === 'TH') {
      for (const attr of ['colspan', 'rowspan']) {
        const v = child.getAttribute(attr);
        if (v && /^\d{1,3}$/.test(v)) el.setAttribute(attr, v);
      }
    }
    sanitizeInto(child, el, insideLink);
    dest.appendChild(el);
  }
}

// Mail-derived HTML is padded with empty paragraphs and long <br> runs.
function trimFiller(root) {
  root.querySelectorAll('p, div').forEach((n) => {
    if (!n.textContent.trim() && !n.querySelector('a, hr, table')) n.remove();
  });
  collapseBreaks(root);
}

// Cap <br> runs at two and drop trailing ones, at every nesting level.
function collapseBreaks(parent) {
  if (parent.tagName === 'PRE') return;
  let run = 0;
  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') {
      run += 1;
      if (run > 2) n.remove();
    } else if (n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim()) {
      continue;
    } else {
      run = 0;
      if (n.nodeType === Node.ELEMENT_NODE) collapseBreaks(n);
    }
  }
  let last = parent.lastChild;
  while (last && ((last.nodeType === Node.ELEMENT_NODE && last.tagName === 'BR')
                  || (last.nodeType === Node.TEXT_NODE && !last.nodeValue.trim()))) {
    last.remove();
    last = parent.lastChild;
  }
}

function renderDescription(el, raw) {
  const text = (raw || '').trim();
  el.textContent = '';
  el.classList.toggle('hidden', !text);
  if (!text) return;

  // Some feeds deliver HTML entity-encoded (&lt;p&gt;), so decode first and ask
  // again — otherwise that markup would be shown as literal text.
  const decoded = looksLikeHtml(text) ? text : decodeEntities(text);

  if (looksLikeHtml(decoded)) {
    el.classList.remove('desc-plain');
    const doc = new DOMParser().parseFromString(decoded, 'text/html');
    sanitizeInto(doc.body, el, false);
    trimFiller(el);
  } else {
    // Plain text keeps its line breaks via CSS white-space: pre-wrap.
    el.classList.add('desc-plain');
    appendLinkedText(decoded, el);
  }
}

const GUEST_MARK = { accepted: '\u2713', declined: '\u2717', tentative: '?', needsAction: '\u00b7' };

function renderGuests(el, attendees) {
  const list = Array.isArray(attendees) ? attendees : [];
  el.textContent = '';
  el.classList.toggle('hidden', list.length === 0);
  if (list.length === 0) return;
  el.appendChild(document.createTextNode('\u{1F465}'));
  const wrap = document.createElement('span');
  for (const a of list) {
    const chip = document.createElement('span');
    chip.className = `guest guest-${a.status}`;
    chip.title = `${a.email}${a.organizer ? ' (organizer)' : ''} \u2014 ${a.status}`;
    chip.textContent = `${GUEST_MARK[a.status] || '\u00b7'} ${a.name || a.email}`;
    wrap.appendChild(chip);
  }
  el.appendChild(wrap);
}

function renderLocation(el, loc) {
  const text = (loc || '').trim();
  el.textContent = '';
  el.classList.toggle('hidden', !text);
  if (!text) return;
  // .modal-row is a flex row, so the text goes in one span rather than
  // becoming several anonymous flex items with gaps between them.
  el.appendChild(document.createTextNode('📍'));
  const span = document.createElement('span');
  appendLinkedText(text, span);
  el.appendChild(span);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Search ──

// HTML descriptions are matched on their readable text, cached per description
// string so a keystroke does not re-parse every cached event.
const descTextCache = new Map();
function searchableDesc(e) {
  const raw = e.description || e.extendedProps?.description || '';
  if (!raw) return '';
  let text = descTextCache.get(raw);
  if (text === undefined) {
    text = descPlainText(raw).toLowerCase();
    descTextCache.set(raw, text);
  }
  return text;
}


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
          searchableDesc(e).includes(q) ||
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

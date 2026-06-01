let calendar;
let dayCal; // lazy day-view calendar inside the day modal
let settings = {};
// Cache of the full (unfiltered) event set per visible date range, so toggling
// a calendar's visibility filters locally without re-hitting the APIs.
const eventCache = new Map(); // "startStr|endStr" -> events[]
const visibility = {}; // calId -> boolean (false = hidden)

document.addEventListener('DOMContentLoaded', async () => {
  showOAuthError();
  settings = await fetch('/api/settings').then((r) => r.json());
  // Seed the visibility map (and sidebar) before the calendar's first fetch,
  // so calendars persisted as hidden don't flash into view on load.
  await renderCalendars();
  initCalendar();
  renderStatus();
  setupZoom();
  setupModals();
  document.getElementById('sync-btn').addEventListener('click', syncNow);
});

// Shared event loader used by both the main calendar and the day modal.
// Caches the full set per date range; filters hidden calendars locally.
async function loadEvents(info) {
  const key = `${info.startStr}|${info.endStr}`;
  let all = eventCache.get(key);
  if (!all) {
    const params = new URLSearchParams({ start: info.startStr, end: info.endStr });
    const data = await fetch(`/api/events?${params}`).then((r) => r.json());
    if (data.errors?.length) {
      showBanner(data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · '));
    } else {
      hideBanner();
    }
    all = data.events || [];
    eventCache.set(key, all);
  }
  return all.filter((e) => visibility[e.calId] !== false);
}

function timeFmt() {
  const hour12 = settings.timeFormat === '12h';
  return { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 };
}

function initCalendar() {
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: settings.defaultView || 'timeGridWeek',
    firstDay: settings.firstDay ?? 1,
    weekends: settings.showWeekends !== false,
    eventTimeFormat: timeFmt(),
    slotLabelFormat: timeFmt(),
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    // Note: no `height: 'auto'` — that makes FullCalendar ignore contentHeight,
    // which is how we zoom. We control the content area height instead.
    contentHeight: 'auto',
    nowIndicator: true,
    dayMaxEvents: true,
    events: (info, success, failure) => loadEvents(info).then(success, failure),
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openModal(info.event);
    },
    // Clicking empty space on a day in month view opens that day's detail view.
    dateClick: (info) => {
      if (calendar.view.type === 'dayGridMonth') openDayModal(info.date);
    },
    // Re-apply zoom whenever the view re-renders (nav or view switch).
    datesSet: applyZoom,
  });
  calendar.render();
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
    visibility[cal.id] = cal.visible; // seed the local visibility map
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
  if (isOutlook) {
    return `https://outlook.office.com/calendar/view/${view}`;
  }
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
  persistCalendar(cal, { visible }); // remember across reloads
  // Re-run the events feed: it's a cache hit, so this just re-filters locally.
  calendar.refetchEvents();
}

function recolorCalendar(cal, color) {
  cal.color = color;
  persistCalendar(cal, { color });
  // Update the cached copies, then re-render from cache (no network).
  for (const list of eventCache.values()) {
    for (const e of list) if (e.calId === cal.id) e.color = color;
  }
  calendar.refetchEvents();
}

// ── Ctrl + scroll to zoom time slots (week/day views) ──
// We zoom by setting FullCalendar's `contentHeight` (slot px × slot rows) and
// letting FullCalendar lay out the events itself — so events always stay
// aligned with the hour lines, no matter how big the change.
const SLOT_MIN = 14, SLOT_MAX = 90;
let slotPx = parseInt(localStorage.getItem('slotPx') || '0', 10) || 0; // 0 = auto
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
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll stays normal scrolling
      if (!calendar.view.type.startsWith('timeGrid')) return;
      e.preventDefault();
      const base = slotPx || 24; // FullCalendar's roughly-default slot height
      slotPx = Math.min(SLOT_MAX, Math.max(SLOT_MIN, base + (e.deltaY < 0 ? 6 : -6)));
      localStorage.setItem('slotPx', String(slotPx));
      // Coalesce rapid wheel ticks into one re-layout per frame.
      if (!zoomScheduled) {
        zoomScheduled = true;
        requestAnimationFrame(() => {
          zoomScheduled = false;
          applyZoom();
        });
      }
    },
    { passive: false }
  );
}

// ── Sync: clear cache and pull fresh data from all calendars ──
async function syncNow() {
  const btn = document.getElementById('sync-btn');
  btn.classList.add('spinning');
  btn.disabled = true;
  eventCache.clear();
  await Promise.all([renderCalendars(), renderStatus()]);
  calendar.refetchEvents();
  if (dayCal) dayCal.refetchEvents();
  setTimeout(() => {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }, 500);
}

// ── Modals (event details + day view) ──
function setupModals() {
  const eventOverlay = document.getElementById('event-modal');
  const dayOverlay = document.getElementById('day-modal');
  const closeEvent = () => eventOverlay.classList.add('hidden');
  const closeDay = () => dayOverlay.classList.add('hidden');

  document.getElementById('modal-close').onclick = closeEvent;
  document.getElementById('day-modal-close').onclick = closeDay;
  eventOverlay.addEventListener('click', (e) => {
    if (e.target === eventOverlay) closeEvent();
  });
  dayOverlay.addEventListener('click', (e) => {
    if (e.target === dayOverlay) closeDay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEvent();
      closeDay();
    }
  });
}

function openDayModal(date) {
  const overlay = document.getElementById('day-modal');
  document.getElementById('day-modal-title').textContent = date.toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
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
  // The calendar was rendered while hidden (zero size). Re-measure now that it's
  // visible, and scroll to the current time so "now" and nearby events show.
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
    // All-day end is exclusive in FullCalendar; show the inclusive last day.
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

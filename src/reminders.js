import { createHash } from 'node:crypto';

// Reminders: decides which events are due a notification, and runs the loop that sends them.
// The pure functions take `now` and the settings as arguments so tests can drive them.

export const LEAD_MINUTES = [0, 5, 10, 15, 30, 60];
const MINUTE = 60_000;
// A reminder at the event's start (lead 0) still goes out this long after the start.
const START_GRACE_MS = 5 * MINUTE;
// An all-day reminder is dropped if it could not go out within this long of its hour.
const ALL_DAY_GRACE_MS = 3 * 60 * MINUTE;
// Sent-reminder records are kept this long past their fire time, then pruned.
const SENT_TTL_MS = 2 * 24 * 60 * MINUTE;

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Milliseconds the wall clock in `tz` is ahead of UTC at instant `t`.
function tzOffset(t, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(t / 1000) * 1000;
}

// The instant at which the wall clock in `tz` reads the given date and hour.
export function zonedTime(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const first = guess - tzOffset(guess, tz);
  // Re-check once: the offset at the guess and at the answer differ across a DST change.
  return guess - tzOffset(first, tz);
}

// When the reminder for `ev` fires, or null if it has none.
export function fireTime(ev, { minutesBefore, allDayHour, timeZone }) {
  if (ev.allDay) {
    if (allDayHour == null) return null;
    return zonedTime(String(ev.start).slice(0, 10), allDayHour, timeZone);
  }
  const start = Date.parse(ev.start);
  return Number.isNaN(start) ? null : start - minutesBefore * MINUTE;
}

// A stable key per reminder, hashed so data/ holds no event ids. A moved event gets a new key.
export function reminderKey(ev, at) {
  return createHash('sha256').update(`${ev.id}|${at}`).digest('hex').slice(0, 24);
}

// The events whose reminder is due at `now` and has not been sent: [{ ev, at, key }].
export function dueReminders(events, now, reminders, sent = {}) {
  const muted = new Set(reminders.mutedCalendars || []);
  const due = [];
  const seen = new Set();
  for (const ev of events) {
    if (!ev || muted.has(ev.calId)) continue;
    const at = fireTime(ev, reminders);
    if (at == null || now < at) continue;
    const latest = ev.allDay
      ? at + ALL_DAY_GRACE_MS
      : Math.max(Date.parse(ev.start), at) + (reminders.minutesBefore === 0 ? START_GRACE_MS : 0);
    if (now >= latest) continue;
    const key = reminderKey(ev, at);
    if (sent[key] || seen.has(key)) continue;
    seen.add(key);
    due.push({ ev, at, key });
  }
  return due;
}

// Drops sent-reminder records whose expiry has passed.
export function pruneSent(sent, now) {
  const kept = {};
  for (const [key, expires] of Object.entries(sent || {})) {
    if (expires > now) kept[key] = expires;
  }
  return kept;
}

function formatTime(t, { timeZone, timeFormat }) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: timeFormat === '12h',
  }).format(new Date(t));
}

// The notification payload the service worker shows.
export function notificationFor({ ev, key }, now, { timeZone, timeFormat }) {
  const parts = [];
  if (ev.allDay) {
    parts.push('Today, all day');
  } else {
    const start = Date.parse(ev.start);
    const mins = Math.round((start - now) / MINUTE);
    parts.push(mins <= 0 ? 'Now' : `In ${mins} min`);
    const end = Date.parse(ev.end);
    const span = formatTime(start, { timeZone, timeFormat })
      + (Number.isNaN(end) ? '' : `–${formatTime(end, { timeZone, timeFormat })}`);
    parts.push(span);
  }
  if (ev.location) parts.push(ev.location);
  return {
    title: ev.title || '(no title)',
    body: parts.join(' · '),
    tag: key,
    url: '/',
  };
}

const REFRESH_MS = 5 * MINUTE;
const TICK_MS = 30_000;

// The loop: refreshes upcoming events every few minutes and sends whatever is due every tick.
// It does nothing while no device is subscribed.
//   deps.fetchEvents(timeMin, timeMax) → events
//   deps.getConfig() → { minutesBefore, allDayHour, mutedCalendars, timeZone, timeFormat }
//   deps.hasSubscribers() → boolean
//   deps.send(payload) → Promise
//   deps.loadSent() / deps.saveSent(sent)
export function createReminderLoop(deps) {
  const now = deps.now || (() => Date.now());
  let events = [];
  let fetchedAt = 0;
  let running = false;
  let timer = null;

  async function tick() {
    if (running || !deps.hasSubscribers()) return;
    running = true;
    try {
      const t = now();
      if (t - fetchedAt >= REFRESH_MS) {
        const timeMin = new Date(t - 24 * 60 * MINUTE).toISOString();
        const timeMax = new Date(t + 48 * 60 * MINUTE).toISOString();
        events = await deps.fetchEvents(timeMin, timeMax);
        fetchedAt = t;
      }
      const config = deps.getConfig();
      let sent = pruneSent(deps.loadSent(), t);
      const due = dueReminders(events, t, config, sent);
      for (const item of due) {
        await deps.send(notificationFor(item, t, config));
        sent = { ...sent, [item.key]: item.at + SENT_TTL_MS };
      }
      if (due.length) deps.saveSent(sent);
    } catch (err) {
      console.error('reminders:', err?.message || err);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    // Forces the next tick to fetch, e.g. after the reminder settings change.
    invalidate() { fetchedAt = 0; },
    start() {
      if (!timer) {
        timer = setInterval(tick, TICK_MS);
        timer.unref?.();
        tick();
      }
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

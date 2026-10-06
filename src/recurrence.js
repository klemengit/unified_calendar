// Repeat rules shared by the Google and CalDAV writers.
//
// The event form offers a small set of repeats (weekly, monthly, yearly) with
// an optional last date. These helpers turn that choice into an iCalendar
// RRULE line, read an RRULE back into the same choice, and format times in
// the user's own time zone, which a repeating event needs: a weekly 09:00
// stored in UTC would move to 10:00 across a daylight-saving change.

export const REPEATS = { weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

// Wall-clock parts of `date` in `timeZone`, as numbers.
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(({ type, value }) => [type, value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// '20261007T090000': `date` as local time in `timeZone`, for DTSTART;TZID=...
export function toIcalLocal(date, timeZone) {
  const { y, mo, d, h, mi, s } = zonedParts(new Date(date), timeZone);
  return `${y}${pad(mo)}${pad(d)}T${pad(h)}${pad(mi)}${pad(s)}`;
}

// '2026-10-07T09:00:00': the same, in the form Google's dateTime accepts
// alongside a separate timeZone.
export function toZonedIso(date, timeZone) {
  const { y, mo, d, h, mi, s } = zonedParts(new Date(date), timeZone);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// The UTC instant of 23:59:59 on `ymd` in `timeZone`.
function endOfLocalDay(ymd, timeZone) {
  return zonedToUtc(`${ymd}T23:59:59`, timeZone);
}

// The UTC instant of wall-clock 'YYYY-MM-DDTHH:MM:SS' in `timeZone`.
export function zonedToUtc(local, timeZone) {
  const [date, time] = local.split('T');
  const [y, mo, day] = date.split('-').map(Number);
  const [h, mi, sec] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, day, h, mi, sec);
  // Shift by the zone's offset at that moment; once more in case the first
  // shift crossed a daylight-saving change.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    t += guess - shown;
  }
  return new Date(t);
}

// 'RRULE:FREQ=WEEKLY;UNTIL=...' for a form choice, or null for no repeat.
// UNTIL is a date for all-day events and the end of that day, in UTC, for
// timed ones, so the last day's occurrence is included.
export function buildRrule({ repeat, repeatUntil, allDay, timeZone }) {
  const freq = REPEATS[repeat];
  if (!freq) return null;
  let rule = `RRULE:FREQ=${freq}`;
  if (repeatUntil) {
    rule += allDay
      ? `;UNTIL=${repeatUntil.replace(/-/g, '')}`
      : `;UNTIL=${endOfLocalDay(repeatUntil, timeZone || 'UTC').toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  }
  return rule;
}

// Reads an RRULE back into the form's terms: { repeat, repeatUntil } when the
// rule is one the form can show, or { repeat: 'custom' } for anything else
// (an interval, a count, several weekdays), which the form leaves untouched.
// BYDAY / BYMONTHDAY / BYMONTH naming a single value are what Google and most
// clients add to a plain weekly, monthly or yearly repeat, so they still count.
export function parseRrule(rule, timeZone) {
  if (!rule) return { repeat: 'none', repeatUntil: null };
  const body = String(rule).split(/\r?\n/).find((l) => /^RRULE:/i.test(l) || /FREQ=/i.test(l)) || '';
  const parts = Object.fromEntries(
    body.replace(/^RRULE:/i, '').split(';').filter(Boolean).map((kv) => {
      const [k, v = ''] = kv.split('=');
      return [k.toUpperCase(), v];
    })
  );
  const repeat = Object.keys(REPEATS).find((k) => REPEATS[k] === (parts.FREQ || '').toUpperCase());
  const single = (k) => !parts[k] || !parts[k].includes(',');
  const allowed = new Set(['FREQ', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST', 'INTERVAL']);
  const simple = repeat
    && Object.keys(parts).every((k) => allowed.has(k))
    && (!parts.INTERVAL || parts.INTERVAL === '1')
    && single('BYDAY') && single('BYMONTHDAY') && single('BYMONTH');
  if (!simple) return { repeat: 'custom', repeatUntil: null };
  return { repeat, repeatUntil: parts.UNTIL ? untilToYmd(parts.UNTIL, timeZone) : null };
}

// UNTIL is either a date (20261231) or a UTC time (20261231T225959Z); show the
// local date it falls on.
function untilToYmd(until, timeZone) {
  const m = until.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return null;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = zonedParts(t, timeZone || 'UTC');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// The local date of a start value: an all-day 'YYYY-MM-DD' as is, a time as
// the date it falls on in `timeZone`.
function localYmd(value, timeZone) {
  if (YMD.test(value)) return value;
  const p = zonedParts(new Date(value), timeZone);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

function ymdToUtc(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  return Date.UTC(y, mo - 1, d);
}

function addDays(ymd, days) {
  return new Date(ymdToUtc(ymd) + days * 86400000).toISOString().slice(0, 10);
}

// Wall-clock 'YYYY-MM-DDTHH:MM:SS' plus a number of milliseconds.
function addWallClock(local, ms) {
  const [d, t] = local.split('T');
  const [h, mi, s] = t.split(':').map(Number);
  const base = ymdToUtc(d) + ((h * 60 + mi) * 60 + s) * 1000;
  return new Date(base + ms).toISOString().slice(0, 19);
}

// New start and end for a whole series when one occurrence was edited with
// "All events". The series moves by as many days as the occurrence did and
// takes the occurrence's new time of day and duration, so editing any
// occurrence edits the series the way it reads, not just its first date.
//
// Returns all-day dates as { start, endExclusive } ('YYYY-MM-DD'), and timed
// values as wall-clock { start, end } ('YYYY-MM-DDTHH:MM:SS') in `timeZone`.
export function shiftSeries({ seriesStart, occurrenceStart, start, end, allDay, timeZone }) {
  const dayShift = (ymdToUtc(localYmd(start, timeZone)) - ymdToUtc(localYmd(occurrenceStart, timeZone))) / 86400000;
  const day = addDays(localYmd(seriesStart, timeZone), dayShift);
  if (allDay) {
    const days = (ymdToUtc(end || start) - ymdToUtc(start)) / 86400000;
    return { start: day, endExclusive: addDays(day, days + 1) };
  }
  const time = toZonedIso(start, timeZone).slice(11);
  const startLocal = `${day}T${time}`;
  const duration = new Date(end || start) - new Date(start);
  return { start: startLocal, end: addWallClock(startLocal, duration) };
}

// Pure VTODO helpers: no network, no fs, no child_process. Everything here is a plain function
// over strings/objects so it can be unit-tested without a server or a CalDAV account.
//
// Open-Xchange (the mailbox.org CalDAV backend) silently discards any VTODO property outside a
// fixed whitelist, and rejects RRULE outright. buildVtodoIcal() only ever writes whitelisted
// properties (plus the structural UID/DTSTAMP/VERSION/PRODID/CREATED) — it has no code path that
// could emit RRULE or RELATED-TO, even if a caller hands us fields with those keys.

// ── iCal text helpers (mirrors src/caldav.js's escText/toIcalUtc; kept as its own small copy so
// this module stays import-free from the network layer, same way src/ics.js keeps its own
// localYmd instead of importing src/caldav.js's) ──

// A bare CR must never reach the wire. Escaping only LF left `\r` as a raw octet in the middle of a
// content line, which (a) silently destroyed the whole property — node-ical's content-line regex
// can't match across it, so reading our own writes back lost the field entirely — and (b) handed a
// caller a way to open what looks like a new property line, smuggling a property past the
// server's VTODO whitelist. CRLF collapses to a single escaped newline, per RFC 5545 §3.3.11.
function escText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function toIcalUtc(dt) {
  return new Date(dt).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

// node-ical builds VALUE=DATE instants as local midnight (`new Date(y, m-1, d)`), so reading them
// back must use local getters, not toISOString() — a UTC read would land on the wrong day for any
// timezone east of Greenwich (see caldav.js's own localYmd/normalizeIcalEvent for the same fix).
function localYmd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ── normalizeVtodo ──

// A node-ical property that carries no interesting parameters comes back as a plain string; one
// that does (e.g. a TZID) comes back as {params, val}. Same pattern src/ics.js already uses for
// vevent.url.
function textOf(prop) {
  if (prop == null) return '';
  return typeof prop === 'string' ? prop : String(prop.val ?? '');
}

// DUE/DTSTART/COMPLETED all go through node-ical's dateParameter(), which stamps `.dateOnly` on
// the resulting Date when the source line was VALUE=DATE. Returns ['YYYY-MM-DD', false] for a
// DATE, [isoUtcString, true] for a DATE-TIME, [null, false] when the property is absent.
// RFC 5545 allows PRIORITY 1-9, but Open-Xchange stores only the three buckets the iCalendar spec
// describes (1-4 high, 5 normal, 6-9 low) and rewrites anything else. Measured against the live
// server: 1-2 come back as 1, 3-6 as 5, 7-9 as 9. Collapsing on the way out means the value we show
// optimistically is the value the next fetch returns, instead of silently changing under the user.
function normalizePriority(value) {
  const n = Math.round(Number(value)) || 0;
  if (n <= 0) return 0;
  if (n <= 2) return 1;
  if (n <= 6) return 5;
  return 9;
}

function completedIso(prop) {
  if (!prop) return null;
  const d = prop instanceof Date ? prop : new Date(String(prop));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dateField(prop) {
  if (!prop) return [null, false];
  const d = prop instanceof Date ? prop : new Date(String(prop));
  if (Number.isNaN(d.getTime())) return [null, false];
  if (prop.dateOnly) return [localYmd(d), false];
  return [d.toISOString(), true];
}

/**
 * Convert a VTODO component, as produced by node-ical's `parseICS`, into the Task shape used
 * across the app. The caller is responsible for filtering to `comp.type === 'VTODO'` first (the
 * same way fetchCalDavEvents filters to VEVENT before calling normalizeIcalEvent).
 */
export function normalizeVtodo(comp, { listId, listName, listUrl, accountId, etag } = {}) {
  const uid = String(comp.uid || '');
  const title = textOf(comp.summary).trim() || '(no title)';
  const notes = textOf(comp.description).trim();
  const status = textOf(comp.status) || 'NEEDS-ACTION';

  const priority = clamp(Math.round(Number(textOf(comp.priority))) || 0, 0, 9);
  const percent = clamp(Math.round(Number(comp.completion)) || 0, 0, 100);

  const categories = Array.isArray(comp.categories)
    ? comp.categories.map((c) => String(c).trim()).filter(Boolean)
    : [];

  const [due, dueHasTime] = dateField(comp.due);
  const [start] = dateField(comp.start);

  // Guarded the same way dateField() guards DUE/DTSTART: another client (or a hand edit) can leave
  // a COMPLETED value this parser hands back as a plain string, and .toISOString() on an invalid
  // Date throws RangeError — which would take down the whole fetch over one bad task.
  const completedAt = completedIso(comp.completed);

  return {
    id: `cdavtodo-${uid}`,
    uid,
    title,
    notes,
    status,
    completed: status === 'COMPLETED',
    completedAt,
    due,
    dueHasTime,
    start,
    priority,
    percent,
    categories,
    listId,
    listName,
    listUrl,
    accountId,
    etag: etag ?? null,
  };
}

// ── buildVtodoIcal ──

// `hasTime` decides VALUE=DATE vs a plain UTC DATE-TIME line.
function dateProp(name, value, hasTime) {
  if (!value) return null;
  if (hasTime) return `${name}:${toIcalUtc(value)}`;
  const compact = String(value).slice(0, 10).replace(/-/g, '');
  return `${name};VALUE=DATE:${compact}`;
}

// DUE-only DATE-only string form.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a CRLF-joined VCALENDAR/VTODO. `fields` may only ever produce whitelisted OX properties
 * (DTSTART, DUE, CATEGORIES, SUMMARY, PRIORITY, DESCRIPTION, STATUS, PERCENT-COMPLETE, COMPLETED)
 * plus the structural UID/DTSTAMP/VERSION/PRODID/CREATED — there is no code path here that reads
 * an RRULE or RELATED-TO key out of `fields`, so passing them in has no effect on the output.
 */
export function buildVtodoIcal(uid, fields = {}) {
  const { title, notes, due, dueHasTime, start, priority, categories, status, percent, completedAt, created } = fields;

  const dtstamp = toIcalUtc(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', `UID:${uid}`, `DTSTAMP:${dtstamp}`,
  ];

  if (created) lines.push(`CREATED:${toIcalUtc(created)}`);

  const dueLine = dateProp('DUE', due, Boolean(dueHasTime));
  if (dueLine) lines.push(dueLine);

  // `start` has no companion `startHasTime` field in the Task shape (DTSTART isn't editable yet
  // outside quick-add, which never sets one) — same self-describing encoding as normalizeVtodo
  // produces, so a bare YYYY-MM-DD string means DATE and anything else means DATE-TIME.
  const startHasTime = start != null && !DATE_ONLY_RE.test(String(start));
  const startLine = dateProp('DTSTART', start, startHasTime);
  if (startLine) lines.push(startLine);

  lines.push(`SUMMARY:${escText(title)}`);
  if (notes) lines.push(`DESCRIPTION:${escText(notes)}`);

  const pr = normalizePriority(priority);
  if (pr > 0) lines.push(`PRIORITY:${pr}`);

  if (Array.isArray(categories) && categories.length) {
    lines.push(`CATEGORIES:${categories.map(escText).join(',')}`);
  }

  lines.push(`STATUS:${status || 'NEEDS-ACTION'}`);

  const pct = clamp(Math.round(Number(percent)) || 0, 0, 100);
  lines.push(`PERCENT-COMPLETE:${pct}`);

  if (completedAt) lines.push(`COMPLETED:${toIcalUtc(completedAt)}`);

  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// ── applyCompletion ──

/**
 * Build the `fields` object for buildVtodoIcal() that flips a task's completion state, carrying
 * the rest of its whitelisted fields through unchanged.
 */
export function applyCompletion(task, completed, now) {
  const fields = {
    title: task.title,
    notes: task.notes,
    due: task.due,
    dueHasTime: task.dueHasTime,
    start: task.start,
    priority: task.priority,
    categories: task.categories,
  };

  if (completed) {
    fields.status = 'COMPLETED';
    fields.percent = 100;
    fields.completedAt = new Date(now).toISOString();
  } else {
    fields.status = 'NEEDS-ACTION';
    fields.percent = 0;
    // completedAt intentionally left unset — buildVtodoIcal only emits COMPLETED when present.
  }

  return fields;
}

// ── parseQuickAdd ──

const CATEGORY_RE = /^@([A-Za-z0-9_-]+)$/;
const PRIORITY_RE = /^!([1-9])$/;
const DUE_RE = /^due:(.+)$/i;
// `+name` picks a task list. Must start with a letter, so a phone number (`+1555...`) or a stray
// `+3d` stays in the title instead of being read as a list nobody has.
const LIST_RE = /^\+(\p{L}[\p{L}\p{M}\p{N}_-]*)$/u;

const WEEKDAYS_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isValidYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function addDays(base, n) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
}

// All date math here is in local (process TZ) calendar days, same convention the rest of the
// codebase uses (caldav.js's localYmd, ics.js's localYmd) rather than explicit UTC arithmetic.
function resolveDueToken(rawToken, now) {
  const t = rawToken.toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (t === 'today') return ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());
  if (t === 'tomorrow') {
    const d = addDays(today, 1);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  const wdIdx = WEEKDAYS_FULL.indexOf(t) !== -1 ? WEEKDAYS_FULL.indexOf(t) : WEEKDAYS_SHORT.indexOf(t);
  if (wdIdx !== -1) {
    // Strictly *after* today: asking for "monday" on a Monday means next Monday, not today.
    const delta = ((wdIdx - today.getDay() + 7) % 7) || 7;
    const d = addDays(today, delta);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    return isValidYmd(y, m, d) ? ymd(y, m, d) : null;
  }

  const plus = /^\+(\d+)([dw])$/.exec(t);
  if (plus) {
    const n = Number(plus[1]) * (plus[2] === 'w' ? 7 : 1);
    const d = addDays(today, n);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  // Slovenian D.M. (next occurrence, this year or next) / D.M.YYYY (literal).
  const sl = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/.exec(t);
  if (sl) {
    const d = Number(sl[1]), m = Number(sl[2]);
    if (sl[3]) {
      const y = Number(sl[3]);
      return isValidYmd(y, m, d) ? ymd(y, m, d) : null;
    }
    let y = today.getFullYear();
    if (!isValidYmd(y, m, d)) return null;
    // "has passed" means strictly before today; today itself still counts as this year's date.
    if (new Date(y, m - 1, d) < today) {
      y += 1;
      if (!isValidYmd(y, m, d)) return null;
    }
    return ymd(y, m, d);
  }

  return null;
}

/**
 * Parse the quick-add grammar, e.g. `call the bank @admin due:friday !1 +errands`.
 * Tokens are only recognised as whole whitespace-separated words — an email address or a
 * `http://x/y!2` inside the text is left alone. Throws when no title text remains, or when more
 * than one `+list` token is given. `listToken` is the list name as typed, without the `+`; turning
 * it into a list is resolveListToken's job, since that needs the discovered lists.
 */
export function parseQuickAdd(text, { now } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now ?? Date.now());
  const words = String(text ?? '').split(/\s+/).filter(Boolean);

  const categories = [];
  let priority = 0;
  let due = null;
  let listToken = null;
  const titleWords = [];

  for (const word of words) {
    const catMatch = CATEGORY_RE.exec(word);
    if (catMatch) { categories.push(catMatch[1]); continue; }

    const prioMatch = PRIORITY_RE.exec(word);
    if (prioMatch) { priority = Number(prioMatch[1]); continue; }

    const listMatch = LIST_RE.exec(word);
    if (listMatch) {
      // Unlike !N (last wins), a second list is refused: filing the task into the wrong list is
      // worse than asking again.
      if (listToken !== null) throw new Error('only one +list token per task');
      listToken = listMatch[1];
      continue;
    }

    const dueMatch = DUE_RE.exec(word);
    if (dueMatch) {
      const resolved = resolveDueToken(dueMatch[1], nowDate);
      if (resolved) { due = resolved; continue; }
      // Unparseable due: token stays verbatim in the title below.
    }

    titleWords.push(word);
  }

  const title = titleWords.join(' ').trim();
  if (!title) throw new Error('task needs a title');

  return { title, categories, due, dueHasTime: false, priority, listToken };
}

// ── resolveListToken ──

// Case- and diacritic-insensitive key for a list name or a `+token`: `Home  Repairs` and
// `home-repairs` fold to the same thing, as do `Čitanje` and `citanje`.
function foldListName(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Pick the task list a quick-add `+token` names. An exact (folded) name wins; otherwise the token
 * must be a prefix of exactly one list name. Returns `{ list }` on a match, or
 * `{ error, reason: 'unknown' | 'ambiguous', candidates }` where `candidates` and `error` carry
 * list names only — never ids or URLs, since the message goes back to the client verbatim.
 * `nameOf` lets a caller pass richer items (e.g. the routes' `{account, list}` entries).
 */
export function resolveListToken(token, lists, nameOf = (item) => item.name) {
  const items = Array.isArray(lists) ? lists : [];
  const key = foldListName(token);
  const folded = items.map((item) => foldListName(nameOf(item)));

  let matches = items.filter((_, i) => folded[i] === key);
  if (matches.length === 0) matches = items.filter((_, i) => folded[i].startsWith(key));
  if (matches.length === 1) return { list: matches[0] };

  if (matches.length > 1) {
    const candidates = matches.map(nameOf);
    return {
      reason: 'ambiguous',
      candidates,
      error: `+${token} matches more than one task list: ${candidates.join(', ')}`,
    };
  }

  const candidates = items.map(nameOf);
  return {
    reason: 'unknown',
    candidates,
    error: candidates.length
      ? `No task list matches +${token}. Lists: ${candidates.join(', ')}`
      : `No task list matches +${token}: no task list is configured yet`,
  };
}

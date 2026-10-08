import axios from 'axios';
import ical from 'node-ical';
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { normalizeVtodo, buildVtodoIcal } from './tasks.js';
import { buildRrule, parseRrule, shiftSeries, toIcalLocal, zonedToUtc } from './recurrence.js';

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  isArray: (name) => ['response', 'propstat'].includes(name),
});

// ── Test seam ──
// No mocking library is a dependency here, so tests substitute the HTTP transport itself: every
// axios call in this module goes through `requestFn` instead of `axios.request` directly.
// Production code never calls __setRequestFn; it exists purely for test/caldav-tasks.test.js.
let requestFn = (config) => axios.request(config);
export function __setRequestFn(fn) {
  requestFn = fn ?? ((config) => axios.request(config));
}

// ── Helpers ──

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function resolveUrl(base, href) {
  if (!href || typeof href !== 'string') return null;
  if (/^https?:\/\//i.test(href)) return href;
  try { return new URL(href, base).href; } catch { return null; }
}

function getOkProp(propstats) {
  const arr = Array.isArray(propstats) ? propstats : propstats ? [propstats] : [];
  return arr.find((ps) => String(ps.status || '').includes('200'))?.prop ?? null;
}

function getResponses(parsed) {
  const r = parsed?.multistatus?.response;
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

async function propfind(url, username, password, body, depth) {
  const resp = await requestFn({
    method: 'PROPFIND',
    url,
    data: body,
    headers: {
      Authorization: basicAuth(username, password),
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: depth,
    },
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (resp.status !== 207) return null;
  return typeof resp.data === 'string' ? xmlParser.parse(resp.data) : resp.data;
}

// ── Discovery ──

async function findPrincipalUrl(server, username, password) {
  const base = server.replace(/\/$/, '');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

  for (const path of ['/', '/.well-known/caldav']) {
    try {
      const parsed = await propfind(`${base}${path}`, username, password, body, '0');
      if (!parsed) continue;
      for (const r of getResponses(parsed)) {
        const prop = getOkProp(r.propstat);
        const href = prop?.['current-user-principal']?.href;
        if (href) return resolveUrl(base, String(href));
      }
    } catch { /* try next path */ }
  }
  throw new Error('CalDAV discovery failed: could not find principal. Check server URL and credentials.');
}

async function findCalendarHome(principalUrl, username, password) {
  const base = new URL(principalUrl).origin;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

  const parsed = await propfind(principalUrl, username, password, body, '0');
  if (!parsed) throw new Error('CalDAV: no response from principal URL');
  for (const r of getResponses(parsed)) {
    const prop = getOkProp(r.propstat);
    const href = prop?.['calendar-home-set']?.href;
    if (href) return resolveUrl(base, String(href));
  }
  throw new Error('CalDAV: could not find calendar-home-set');
}

function assignCalendarIds(accountId, calendars) {
  const seen = new Set();
  return calendars.map((cal) => {
    const seg = cal.url.replace(/\/$/, '').split('/').filter(Boolean).pop() || 'cal';
    let id = `${accountId}_${seg}`;
    let n = 2;
    while (seen.has(id)) { id = `${accountId}_${seg}_${n++}`; }
    seen.add(id);
    return { ...cal, id };
  });
}

// Shared PROPFIND walk for both event calendars and task lists: same request, same resourcetype
// filter, same name/color extraction. Callers filter the result by `compSet` for the component
// they care about (VEVENT vs VTODO) — kept as raw values so a collection advertising both (as
// task discovery's tests check for) matches either filter.
async function walkCalendarCollections(homeUrl, username, password) {
  const base = new URL(homeUrl).origin;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:i="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <i:calendar-color/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

  const parsed = await propfind(homeUrl, username, password, body, '1');
  if (!parsed) return [];
  const collections = [];

  for (const r of getResponses(parsed)) {
    const prop = getOkProp(r.propstat);
    if (!prop) continue;

    const rt = prop.resourcetype;
    if (!rt || typeof rt !== 'object' || !('calendar' in rt)) continue;

    const href = resolveUrl(base, String(r.href ?? ''));
    if (!href) continue;

    const rawName = prop.displayname;
    const name = rawName != null && rawName !== '' ? String(rawName) : href.replace(/\/$/, '').split('/').pop() || 'Calendar';
    let color = prop['calendar-color'] ? String(prop['calendar-color']).slice(0, 7) : null;
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) color = null;

    collections.push({ url: href, name, color, compSet: prop['supported-calendar-component-set'] });
  }

  return collections;
}

function componentSetIncludes(compSet, component) {
  return Boolean(compSet) && JSON.stringify(compSet).toLowerCase().includes(component.toLowerCase());
}

async function listCalendarsAtHome(homeUrl, username, password, accountId) {
  const collections = await walkCalendarCollections(homeUrl, username, password);
  // Unchanged from before the refactor: a collection with no supported-calendar-component-set at
  // all is kept (assumed to be an event calendar); one that declares a set must include VEVENT.
  const calendars = collections
    .filter((c) => !c.compSet || componentSetIncludes(c.compSet, 'vevent'))
    .map(({ url, name, color }) => ({ url, name, color }));
  return assignCalendarIds(accountId, calendars);
}

async function listTaskListsAtHome(homeUrl, username, password, accountId) {
  const collections = await walkCalendarCollections(homeUrl, username, password);
  const lists = collections
    .filter((c) => componentSetIncludes(c.compSet, 'vtodo'))
    .map(({ url, name, color }) => ({ url, name, color }));
  return assignCalendarIds(accountId, lists);
}

export async function discoverCalendars(server, username, password, accountId) {
  const principalUrl = await findPrincipalUrl(server, username, password);
  const homeUrl = await findCalendarHome(principalUrl, username, password);
  return listCalendarsAtHome(homeUrl, username, password, accountId);
}

// Same PROPFIND walk as discoverCalendars, kept to task-list collections (supported-calendar-
// component-set contains VTODO) instead of VEVENT ones.
export async function discoverTaskLists(server, username, password, accountId) {
  const principalUrl = await findPrincipalUrl(server, username, password);
  const homeUrl = await findCalendarHome(principalUrl, username, password);
  return listTaskListsAtHome(homeUrl, username, password, accountId);
}

// ── Event fetching ──

function localYmd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toIcalUtc(dt) {
  return new Date(dt).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function normalizeIcalEvent(vevent, calId, accountId, calUrl, color, source) {
  const uid = String(vevent.uid || '');
  const allDay = vevent.datetype === 'date';
  const s = vevent.start instanceof Date ? vevent.start : new Date(String(vevent.start));
  const e = vevent.end instanceof Date ? vevent.end : s;
  return {
    id: `cdav-${uid}`,
    title: vevent.summary || '(no title)',
    start: allDay ? localYmd(s) : s.toISOString(),
    end: allDay ? localYmd(e) : e.toISOString(),
    allDay,
    color,
    calId,
    caldavEventUid: uid,
    caldavCalUrl: calUrl,
    caldavAccountId: accountId,
    source,
    originalUrl: null,
    location: vevent.location || '',
    description: (vevent.description || '').trim(),
  };
}

export async function fetchCalDavEvents(account, calendar, timeMin, timeMax) {
  const startStr = toIcalUtc(timeMin);
  const endStr = toIcalUtc(timeMax);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startStr}" end="${endStr}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  let resp;
  try {
    resp = await requestFn({
      method: 'REPORT',
      url: calendar.url,
      data: body,
      headers: {
        Authorization: basicAuth(account.username, account.password),
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: '1',
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new Error(`CalDAV REPORT failed: ${e.message}`);
  }

  if (resp.status === 404) return [];
  if (resp.status !== 207) throw new Error(`CalDAV REPORT returned ${resp.status}`);

  const parsed = typeof resp.data === 'string' ? xmlParser.parse(resp.data) : resp.data;
  const events = [];

  for (const r of getResponses(parsed)) {
    const prop = getOkProp(r.propstat);
    const calData = prop?.['calendar-data'];
    if (!calData) continue;
    try {
      const parsed2 = ical.parseICS(String(calData));
      for (const key of Object.keys(parsed2)) {
        const comp = parsed2[key];
        if (!comp || comp.type !== 'VEVENT' || !comp.start) continue;
        if (!comp.rrule) {
          events.push({
            ...normalizeIcalEvent(comp, calendar.id, account.id, calendar.url, calendar.color, account.displayName),
            repeat: 'none',
            repeatUntil: null,
          });
          continue;
        }
        events.push(...expandSeries(comp, timeMin, timeMax, calendar, account));
      }
    } catch { /* skip unparseable */ }
  }
  return events;
}

// One event per occurrence of a repeating event within the window, with
// excluded dates skipped and individually edited occurrences in place of the
// ones they replace. Each carries the start it had in the series
// (occurrenceStart), which is how a "This event" edit names it.
function expandSeries(comp, timeMin, timeMax, calendar, account) {
  const allDay = comp.datetype === 'date';
  const { repeat, repeatUntil } = parseRrule(comp.rrule.toString(), comp.start.tz);
  const instances = ical.expandRecurringEvent(comp, {
    from: new Date(timeMin),
    to: new Date(timeMax),
    expandOngoing: true,
  });
  return instances.map((inst) => {
    const original = inst.isOverride ? inst.event.recurrenceid : inst.start;
    const occurrenceStart = allDay ? localYmd(original) : original.toISOString();
    const base = normalizeIcalEvent(
      { ...inst.event, uid: comp.uid, start: inst.start, end: inst.end, datetype: comp.datetype },
      calendar.id, account.id, calendar.url, calendar.color, account.displayName
    );
    return {
      ...base,
      id: `cdav-${comp.uid}-${occurrenceStart}`,
      recurring: true,
      seriesId: String(comp.uid),
      occurrenceStart,
      repeat,
      repeatUntil,
    };
  });
}

// ── iCal generation ──

// See the matching note in src/tasks.js: escaping LF but not CR left a bare `\r` on the wire, which
// both destroyed the property on read-back and let a title or description open a new property line.
function escText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function addOneDay(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The lines of one VEVENT. A repeating timed event is written in the user's
// time zone (DTSTART;TZID=...), so its occurrences keep their local time across
// daylight-saving changes; everything else stays in UTC, as before.
function veventLines(uid, eventData, extra = []) {
  const { title, start, end, allDay, description, location, timeZone, repeat, repeatUntil } = eventData;
  const rrule = eventData.rrule !== undefined ? eventData.rrule : buildRrule({ repeat, repeatUntil, allDay, timeZone });
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${toIcalUtc(new Date().toISOString())}`, ...extra];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${(start || '').replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${addOneDay(end || start).replace(/-/g, '')}`);
  } else if (rrule && timeZone) {
    lines.push(`DTSTART;TZID=${timeZone}:${toIcalLocal(start, timeZone)}`);
    lines.push(`DTEND;TZID=${timeZone}:${toIcalLocal(end || start, timeZone)}`);
  } else {
    lines.push(`DTSTART:${toIcalUtc(start)}`);
    lines.push(`DTEND:${toIcalUtc(end || start)}`);
  }
  if (rrule) lines.push(rrule);
  lines.push(`SUMMARY:${escText(title)}`);
  if (description) lines.push(`DESCRIPTION:${escText(description)}`);
  if (location) lines.push(`LOCATION:${escText(location)}`);
  lines.push('END:VEVENT');
  return lines;
}

function wrapCalendar(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function buildIcal(uid, eventData) {
  return wrapCalendar(veventLines(uid, eventData));
}

function makeEvent(uid, eventData, calendar, account) {
  const { title, start, end, allDay, description, location } = eventData;
  return {
    id: `cdav-${uid}`,
    title: title || '(no title)',
    start: allDay ? (start || '') : new Date(start).toISOString(),
    end: allDay ? (end || start || '') : new Date(end || start).toISOString(),
    allDay: Boolean(allDay),
    color: calendar.color,
    calId: calendar.id,
    caldavEventUid: uid,
    caldavCalUrl: calendar.url,
    caldavAccountId: account.id,
    source: account.displayName,
    originalUrl: null,
    location: (location || '').trim(),
    description: (description || '').trim(),
  };
}

function eventUrl(calUrl, uid) {
  return `${calUrl.replace(/\/$/, '')}/${uid}.ics`;
}

// ── CRUD ──

export async function createCalDavEvent(account, calendar, eventData) {
  const uid = crypto.randomUUID();
  const resp = await requestFn({
    method: 'PUT',
    url: eventUrl(calendar.url, uid),
    data: buildIcal(uid, eventData),
    headers: {
      Authorization: basicAuth(account.username, account.password),
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`CalDAV PUT failed: ${resp.status}`);
  return makeEvent(uid, eventData, calendar, account);
}

export async function updateCalDavEvent(account, calendar, uid, eventData) {
  await requestFn({
    method: 'PUT',
    url: eventUrl(calendar.url, uid),
    data: buildIcal(uid, eventData),
    headers: {
      Authorization: basicAuth(account.username, account.password),
      'Content-Type': 'text/calendar; charset=utf-8',
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return makeEvent(uid, eventData, calendar, account);
}

// MOVE rather than PUT-then-DELETE: servers such as mailbox.org refuse a second
// copy of a UID even for a moment, and MOVE keeps the UID (so stars survive).
export async function moveCalDavEvent(account, uid, fromCalUrl, toCalUrl) {
  await requestFn({
    method: 'MOVE',
    url: eventUrl(fromCalUrl, uid),
    headers: {
      Authorization: basicAuth(account.username, account.password),
      Destination: eventUrl(toCalUrl, uid),
      Overwrite: 'F',
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

export async function deleteCalDavEvent(account, uid, calUrl) {
  await requestFn({
    method: 'DELETE',
    url: eventUrl(calUrl, uid),
    headers: { Authorization: basicAuth(account.username, account.password) },
    validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
  });
}

// ── Tasks (VTODO) ──

export async function fetchCalDavTasks(account, list) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  let resp;
  try {
    resp = await requestFn({
      method: 'REPORT',
      url: list.url,
      data: body,
      headers: {
        Authorization: basicAuth(account.username, account.password),
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: '1',
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new Error(`CalDAV REPORT failed: ${e.message}`);
  }

  if (resp.status === 404) return [];
  if (resp.status !== 207) throw new Error(`CalDAV REPORT returned ${resp.status}`);

  const parsed = typeof resp.data === 'string' ? xmlParser.parse(resp.data) : resp.data;
  const tasks = [];

  for (const r of getResponses(parsed)) {
    const prop = getOkProp(r.propstat);
    const calData = prop?.['calendar-data'];
    if (!calData) continue;
    // getetag comes back from OX UNQUOTED (e.g. `1111673-3-1784650673809`) — kept as-is, never
    // quoted/unquoted here or anywhere downstream, so it round-trips verbatim into If-Match.
    const etag = prop?.getetag != null ? String(prop.getetag) : null;
    try {
      const parsedIcs = ical.parseICS(String(calData));
      for (const key of Object.keys(parsedIcs)) {
        const comp = parsedIcs[key];
        if (!comp || comp.type !== 'VTODO') continue;
        tasks.push(normalizeVtodo(comp, {
          listId: list.id, listName: list.name, listUrl: list.url, accountId: account.id, etag,
          href: resolveUrl(list.url, r.href),
        }));
      }
    } catch { /* one malformed VTODO must not fail the whole fetch */ }
  }
  return tasks;
}

function vtodoFromIcal(icalText) {
  return Object.values(ical.parseICS(icalText)).find((c) => c && c.type === 'VTODO');
}

export async function createCalDavTask(account, list, fields) {
  const uid = crypto.randomUUID();
  const icalText = buildVtodoIcal(uid, fields);

  const resp = await requestFn({
    method: 'PUT',
    url: eventUrl(list.url, uid),
    data: icalText,
    headers: {
      Authorization: basicAuth(account.username, account.password),
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
    },
    validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`CalDAV PUT failed: ${resp.status}`);

  const etag = resp.headers?.etag != null ? String(resp.headers.etag) : null;
  return normalizeVtodo(vtodoFromIcal(icalText), {
    listId: list.id, listName: list.name, listUrl: list.url, accountId: account.id, etag,
    href: eventUrl(list.url, uid),
  });
}

// Flip a task's completion state by editing its stored file in place, so
// properties this app does not model (alarms, repeat rules, subtasks, X-
// properties, the original time zones) survive the edit. Only STATUS,
// PERCENT-COMPLETE, COMPLETED and the timestamps change.
export async function updateCalDavTask(account, list, task, fields) {
  const url = task.href || eventUrl(list.url, encodeURIComponent(task.uid));
  const auth = basicAuth(account.username, account.password);

  const got = await requestFn({
    method: 'GET',
    url,
    headers: { Authorization: auth },
    responseType: 'text',
    transformResponse: (d) => d,
    validateStatus: () => true,
  });
  if (got.status === 404) {
    throw new Error('CalDAV PUT failed: task was changed on the server since it was last fetched (404 Not Found)');
  }
  if (got.status < 200 || got.status >= 300) throw new Error(`CalDAV GET failed: ${got.status}`);

  const icalText = setVtodoCompletion(unfoldLines(String(got.data)), fields).map(foldLine).join('\r\n');

  const headers = { Authorization: auth, 'Content-Type': 'text/calendar; charset=utf-8' };
  // Sent back exactly as stored — see the verbatim-etag note in fetchCalDavTasks. Omitted (PUT
  // unconditional) when we never had one to begin with.
  const etag = got.headers?.etag != null ? String(got.headers.etag) : task.etag;
  if (etag != null) headers['If-Match'] = etag;

  const resp = await requestFn({ method: 'PUT', url, data: icalText, headers, validateStatus: () => true });

  if (resp.status === 412) {
    throw new Error('CalDAV PUT failed: task was changed on the server since it was last fetched (412 Precondition Failed)');
  }
  if (resp.status < 200 || resp.status >= 300) throw new Error(`CalDAV PUT failed: ${resp.status}`);

  const newEtag = resp.headers?.etag != null ? String(resp.headers.etag) : null;
  return normalizeVtodo(vtodoFromIcal(icalText), {
    listId: list.id, listName: list.name, listUrl: list.url, accountId: account.id, etag: newEtag, href: url,
  });
}

const COMPLETION_PROPS = new Set(['STATUS', 'PERCENT-COMPLETE', 'COMPLETED', 'DTSTAMP', 'LAST-MODIFIED']);

function setVtodoCompletion(lines, { status, percent, completedAt }) {
  const begin = lines.indexOf('BEGIN:VTODO');
  const end = lines.indexOf('END:VTODO', begin);
  if (begin < 0 || end < 0) throw new Error('CalDAV task has no VTODO');
  const now = toIcalUtc(new Date().toISOString());
  const body = lines.slice(begin + 1, end).filter((l) => !COMPLETION_PROPS.has(splitLine(l).name));
  body.push(`DTSTAMP:${now}`, `LAST-MODIFIED:${now}`, `STATUS:${status || 'NEEDS-ACTION'}`);
  body.push(`PERCENT-COMPLETE:${Math.min(100, Math.max(0, Math.round(Number(percent)) || 0))}`);
  if (completedAt) body.push(`COMPLETED:${toIcalUtc(completedAt)}`);
  return [...lines.slice(0, begin + 1), ...body, ...lines.slice(end)];
}

// ── Repeating events ──
//
// A repeating event is one .ics file: the series VEVENT (with RRULE and any
// EXDATE lines) plus one VEVENT per individually edited occurrence, each named
// by a RECURRENCE-ID. These functions edit that file in place, line by line,
// so properties this app does not know about (alarms, attendees, categories)
// survive the edit.

async function getIcal(account, calUrl, uid) {
  const resp = await requestFn({
    method: 'GET',
    url: eventUrl(calUrl, uid),
    headers: { Authorization: basicAuth(account.username, account.password) },
    responseType: 'text',
    transformResponse: (d) => d,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return String(resp.data);
}

async function putIcal(account, calUrl, uid, lines) {
  await requestFn({
    method: 'PUT',
    url: eventUrl(calUrl, uid),
    data: lines.map(foldLine).join('\r\n'),
    headers: {
      Authorization: basicAuth(account.username, account.password),
      'Content-Type': 'text/calendar; charset=utf-8',
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

// Long lines continue on the next line after a space (RFC 5545 3.1).
function unfoldLines(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
}

function foldLine(line) {
  if (line.length <= 74) return line;
  const parts = [];
  for (let i = 0; i < line.length; i += 73) parts.push(line.slice(i, i + 73));
  return parts.join('\r\n ');
}

// 'DTSTART;TZID=Europe/Ljubljana:20261007T090000' → name, params, value.
function splitLine(line) {
  const m = line.match(/^([A-Za-z-]+)((?:;[^:"]*(?:"[^"]*"[^:"]*)*)*):(.*)$/);
  return m ? { name: m[1].toUpperCase(), params: m[2], value: m[3] } : { name: '', params: '', value: '' };
}

function propLine(block, name) {
  return block.find((l) => splitLine(l).name === name) || null;
}

// The VEVENT blocks of a file, as index ranges into its lines.
function veventBlocks(lines) {
  const blocks = [];
  let start = -1;
  lines.forEach((l, i) => {
    if (l === 'BEGIN:VEVENT') start = i;
    else if (l === 'END:VEVENT' && start >= 0) {
      const body = lines.slice(start, i + 1);
      blocks.push({ start, end: i, body, recurrenceId: propLine(body, 'RECURRENCE-ID') });
      start = -1;
    }
  });
  return blocks;
}

function seriesBlock(lines) {
  const block = veventBlocks(lines).find((b) => !b.recurrenceId && propLine(b.body, 'RRULE'));
  if (!block) throw new Error('This event no longer repeats on the server; refresh and try again.');
  return block;
}

function isIanaZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// A RECURRENCE-ID or EXDATE line naming one occurrence, written the way the
// series writes its DTSTART (a date, a time in a zone, or UTC), which is how
// servers and other clients match it to the occurrence.
function occurrenceLine(name, seriesDtstart, occurrenceStart, fallbackTz) {
  const { params, value } = splitLine(seriesDtstart);
  if (/VALUE=DATE(?!-)/i.test(params)) return `${name};VALUE=DATE:${occurrenceStart.slice(0, 10).replace(/-/g, '')}`;
  const tzid = params.match(/TZID=("?)([^;:"]+)\1/i)?.[2];
  if (tzid) {
    const zone = isIanaZone(tzid) ? tzid : fallbackTz;
    return `${name};TZID=${tzid}:${toIcalLocal(occurrenceStart, zone)}`;
  }
  if (value.endsWith('Z')) return `${name}:${toIcalUtc(occurrenceStart)}`;
  return `${name}:${toIcalLocal(occurrenceStart, fallbackTz)}`;
}

function withoutOverride(lines, ridValue) {
  const drop = veventBlocks(lines).find((b) => b.recurrenceId && splitLine(b.recurrenceId).value === ridValue);
  return drop ? [...lines.slice(0, drop.start), ...lines.slice(drop.end + 1)] : lines;
}

function insertBeforeCalendarEnd(lines, extra) {
  const end = lines.lastIndexOf('END:VCALENDAR');
  return [...lines.slice(0, end), ...extra, ...lines.slice(end)];
}

// "This event": write one occurrence's own times and details as an override
// of the series, replacing any earlier override of the same occurrence.
export async function updateCalDavOccurrence(account, calendar, uid, occurrenceStart, eventData) {
  let lines = unfoldLines(await getIcal(account, calendar.url, uid));
  const series = seriesBlock(lines);
  const tz = eventData.timeZone || 'UTC';
  const rid = occurrenceLine('RECURRENCE-ID', propLine(series.body, 'DTSTART'), occurrenceStart, tz);
  lines = withoutOverride(lines, splitLine(rid).value);
  lines = insertBeforeCalendarEnd(lines, veventLines(uid, { ...eventData, rrule: null }, [rid]));
  await putIcal(account, calendar.url, uid, lines);
}

// "This event" delete: exclude the occurrence from the series.
export async function deleteCalDavOccurrence(account, calendar, uid, occurrenceStart, timeZone) {
  let lines = unfoldLines(await getIcal(account, calendar.url, uid));
  const series = seriesBlock(lines);
  const exdate = occurrenceLine('EXDATE', propLine(series.body, 'DTSTART'), occurrenceStart, timeZone || 'UTC');
  lines = withoutOverride(lines, splitLine(occurrenceLine('RECURRENCE-ID', propLine(series.body, 'DTSTART'), occurrenceStart, timeZone || 'UTC')).value);
  const { end } = seriesBlock(lines);
  lines = [...lines.slice(0, end), exdate, ...lines.slice(end)];
  await putIcal(account, calendar.url, uid, lines);
}

// "All events": edit the series. It moves by as many days as the edited
// occurrence did and takes its time and duration (see shiftSeries); the repeat
// changes only when the form changed it. When the series start moves, its
// excluded dates and edited occurrences no longer line up with the new
// occurrences, so they are dropped, as Google does.
export async function updateCalDavSeries(account, calendar, uid, occurrenceStart, eventData) {
  const text = await getIcal(account, calendar.url, uid);
  let lines = unfoldLines(text);
  const series = seriesBlock(lines);
  const comp = Object.values(ical.parseICS(text)).find((c) => c?.type === 'VEVENT' && c.rrule);
  const seriesAllDay = comp?.datetype === 'date';
  const tz = eventData.timeZone || (isIanaZone(comp?.start?.tz) ? comp.start.tz : 'UTC');
  const seriesStart = seriesAllDay ? localYmd(comp.start) : comp.start.toISOString();
  const shifted = shiftSeries({
    seriesStart, occurrenceStart, start: eventData.start, end: eventData.end, allDay: eventData.allDay, timeZone: tz,
  });

  const oldRule = propLine(series.body, 'RRULE');
  let rrule;
  if (eventData.repeat === undefined || eventData.repeat === 'custom') {
    // A simple rule is rebuilt from the new start, so a weekday or month day
    // named in it (BYDAY=WE) follows the series when it moves.
    const { repeat, repeatUntil } = parseRrule(oldRule, tz);
    rrule = repeat === 'custom' ? oldRule : buildRrule({ repeat, repeatUntil, allDay: eventData.allDay, timeZone: tz });
  } else {
    rrule = buildRrule({ repeat: eventData.repeat, repeatUntil: eventData.repeatUntil, allDay: eventData.allDay, timeZone: tz });
  }

  const times = eventData.allDay
    ? [`DTSTART;VALUE=DATE:${shifted.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${shifted.endExclusive.replace(/-/g, '')}`]
    : [`DTSTART;TZID=${tz}:${shifted.start.replace(/[-:]/g, '')}`, `DTEND;TZID=${tz}:${shifted.end.replace(/[-:]/g, '')}`];
  const startMoved = eventData.allDay
    ? !seriesAllDay || shifted.start !== seriesStart
    : seriesAllDay || zonedToUtc(shifted.start, tz).getTime() !== comp.start.getTime();
  const keepExceptions = rrule && !startMoved;

  const replaced = new Set(['DTSTART', 'DTEND', 'DURATION', 'RRULE', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'DTSTAMP']);
  if (!keepExceptions) replaced.add('EXDATE');
  // Only the event's own lines; a nested VALARM keeps its DESCRIPTION.
  let depth = 0;
  const kept = series.body.slice(1, -1).filter((l) => {
    if (l.startsWith('BEGIN:')) depth++;
    const own = depth === 0;
    if (l.startsWith('END:')) depth--;
    return !own || !replaced.has(splitLine(l).name);
  });
  const uidAt = kept.findIndex((l) => splitLine(l).name === 'UID');
  const fresh = [
    `DTSTAMP:${toIcalUtc(new Date().toISOString())}`,
    ...times,
    ...(rrule ? [rrule] : []),
    `SUMMARY:${escText(eventData.title)}`,
    ...(eventData.description ? [`DESCRIPTION:${escText(eventData.description)}`] : []),
    ...(eventData.location ? [`LOCATION:${escText(eventData.location)}`] : []),
  ];
  const body = ['BEGIN:VEVENT', ...kept.slice(0, uidAt + 1), ...fresh, ...kept.slice(uidAt + 1), 'END:VEVENT'];

  lines = [...lines.slice(0, series.start), ...body, ...lines.slice(series.end + 1)];
  if (!keepExceptions) {
    for (const b of veventBlocks(lines).filter((b) => b.recurrenceId).reverse()) {
      lines = [...lines.slice(0, b.start), ...lines.slice(b.end + 1)];
    }
  }
  await putIcal(account, calendar.url, uid, lines);
}

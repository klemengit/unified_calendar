import axios from 'axios';
import ical from 'node-ical';
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  isArray: (name) => ['response', 'propstat'].includes(name),
});

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
  const resp = await axios.request({
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

async function listCalendarsAtHome(homeUrl, username, password, accountId) {
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
  const calendars = [];

  for (const r of getResponses(parsed)) {
    const prop = getOkProp(r.propstat);
    if (!prop) continue;

    const rt = prop.resourcetype;
    if (!rt || typeof rt !== 'object' || !('calendar' in rt)) continue;

    const compSet = prop['supported-calendar-component-set'];
    if (compSet && !JSON.stringify(compSet).toLowerCase().includes('vevent')) continue;

    const href = resolveUrl(base, String(r.href ?? ''));
    if (!href) continue;

    const rawName = prop.displayname;
    const name = rawName != null && rawName !== '' ? String(rawName) : href.replace(/\/$/, '').split('/').pop() || 'Calendar';
    let color = prop['calendar-color'] ? String(prop['calendar-color']).slice(0, 7) : null;
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) color = null;

    calendars.push({ url: href, name, color });
  }

  return assignCalendarIds(accountId, calendars);
}

export async function discoverCalendars(server, username, password, accountId) {
  const principalUrl = await findPrincipalUrl(server, username, password);
  const homeUrl = await findCalendarHome(principalUrl, username, password);
  return listCalendarsAtHome(homeUrl, username, password, accountId);
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
    resp = await axios.request({
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
        events.push(normalizeIcalEvent(comp, calendar.id, account.id, calendar.url, calendar.color, account.displayName));
      }
    } catch { /* skip unparseable */ }
  }
  return events;
}

// ── iCal generation ──

function escText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function addOneDay(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildIcal(uid, { title, start, end, allDay, description, location }) {
  const dtstamp = toIcalUtc(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`,
  ];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${(start || '').replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${addOneDay(end || start).replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${toIcalUtc(start)}`);
    lines.push(`DTEND:${toIcalUtc(end || start)}`);
  }
  lines.push(`SUMMARY:${escText(title)}`);
  if (description) lines.push(`DESCRIPTION:${escText(description)}`);
  if (location) lines.push(`LOCATION:${escText(location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
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
  const resp = await axios.request({
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
  await axios.request({
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

export async function deleteCalDavEvent(account, uid, calUrl) {
  await axios.request({
    method: 'DELETE',
    url: eventUrl(calUrl, uid),
    headers: { Authorization: basicAuth(account.username, account.password) },
    validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
  });
}

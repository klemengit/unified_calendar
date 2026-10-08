process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';

import { buildRrule, parseRrule, shiftSeries } from '../src/recurrence.js';
import {
  fetchCalDavEvents,
  createCalDavEvent,
  updateCalDavOccurrence,
  deleteCalDavOccurrence,
  updateCalDavSeries,
} from '../src/caldav.js';
import { updateGoogleSeries, createGoogleEvent } from '../src/calendar.js';

const TZ = 'Europe/Ljubljana';

// ── Rules ──

test('recurrence.js buildRrule: weekly with an end date ends after that local day, in UTC', () => {
  assert.equal(
    buildRrule({ repeat: 'weekly', repeatUntil: '2026-12-31', allDay: false, timeZone: TZ }),
    'RRULE:FREQ=WEEKLY;UNTIL=20261231T225959Z'
  );
  assert.equal(buildRrule({ repeat: 'yearly', repeatUntil: '2030-05-01', allDay: true }), 'RRULE:FREQ=YEARLY;UNTIL=20300501');
  assert.equal(buildRrule({ repeat: 'monthly' }), 'RRULE:FREQ=MONTHLY');
  assert.equal(buildRrule({ repeat: 'none' }), null);
});

test('recurrence.js parseRrule: plain rules read back; anything the form cannot show is custom', () => {
  assert.deepEqual(parseRrule('RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T225959Z', TZ), { repeat: 'weekly', repeatUntil: '2026-12-31' });
  assert.deepEqual(parseRrule('RRULE:FREQ=YEARLY'), { repeat: 'yearly', repeatUntil: null });
  assert.deepEqual(parseRrule(null), { repeat: 'none', repeatUntil: null });
  assert.equal(parseRrule('RRULE:FREQ=WEEKLY;BYDAY=MO,WE').repeat, 'custom');
  assert.equal(parseRrule('RRULE:FREQ=WEEKLY;INTERVAL=2').repeat, 'custom');
  assert.equal(parseRrule('RRULE:FREQ=DAILY').repeat, 'custom');
  assert.equal(parseRrule('RRULE:FREQ=MONTHLY;COUNT=5').repeat, 'custom');
});

test('recurrence.js shiftSeries: the series moves by the days the occurrence moved and takes its new time', () => {
  // Series from Wed 2 Sep 09:00; the 7 Oct occurrence moved to Thu 8 Oct 10:30-11:30.
  assert.deepEqual(
    shiftSeries({
      seriesStart: '2026-09-02T07:00:00.000Z',
      occurrenceStart: '2026-10-07T07:00:00.000Z',
      start: '2026-10-08T08:30:00.000Z',
      end: '2026-10-08T09:30:00.000Z',
      allDay: false,
      timeZone: TZ,
    }),
    { start: '2026-09-03T10:30:00', end: '2026-09-03T11:30:00' }
  );
  assert.deepEqual(
    shiftSeries({ seriesStart: '2026-01-05', occurrenceStart: '2026-10-05', start: '2026-10-06', end: '2026-10-07', allDay: true, timeZone: TZ }),
    { start: '2026-01-06', endExclusive: '2026-01-08' }
  );
});

// ── CalDAV ──

const SERIES = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN',
  'BEGIN:VEVENT', 'UID:abc', 'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Ljubljana:20260902T090000', 'DTEND;TZID=Europe/Ljubljana:20260902T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T225959Z',
  'EXDATE;TZID=Europe/Ljubljana:20261014T090000',
  'SUMMARY:Weekly', 'CATEGORIES:Work',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:abc', 'DTSTAMP:20260101T000000Z',
  'RECURRENCE-ID;TZID=Europe/Ljubljana:20261007T090000',
  'DTSTART:20261007T120000Z', 'DTEND:20261007T130000Z', 'SUMMARY:Moved once', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// A CalDAV server holding one file; records what is written to it.
async function fakeServer(t, initial = SERIES) {
  const state = { ics: initial, puts: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'REPORT') {
        res.statusCode = 207;
        res.setHeader('Content-Type', 'application/xml');
        const esc = state.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/abc.ics</d:href><d:propstat><d:prop><c:calendar-data>${esc}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      } else if (req.method === 'GET') {
        res.end(state.ics);
      } else if (req.method === 'PUT') {
        state.puts.push({ url: req.url, body });
        state.ics = body;
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = 405;
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    account: { id: 'acc', username: 'u', password: 'p', displayName: 'Box' },
    calendar: { id: 'cdav_x', url: `${base}/cal/`, color: '#123456' },
  };
}

const lines = (ics) => ics.replace(/\r\n[ \t]/g, '').split('\r\n');

test('caldav.js fetchCalDavEvents: a repeating event becomes one event per occurrence, with exclusions and edits applied', async (t) => {
  const { account, calendar } = await fakeServer(t);
  const events = await fetchCalDavEvents(account, calendar, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  const summary = events.map((e) => [e.title, e.start, e.occurrenceStart]);
  assert.deepEqual(summary, [
    ['Moved once', '2026-10-07T12:00:00.000Z', '2026-10-07T07:00:00.000Z'],
    ['Weekly', '2026-10-21T07:00:00.000Z', '2026-10-21T07:00:00.000Z'],
    // 09:00 local after the clocks went back on 25 Oct.
    ['Weekly', '2026-10-28T08:00:00.000Z', '2026-10-28T08:00:00.000Z'],
  ]);
  assert.ok(events.every((e) => e.recurring && e.seriesId === 'abc' && e.repeat === 'weekly' && e.repeatUntil === '2026-12-31'));
  assert.equal(new Set(events.map((e) => e.id)).size, 3, 'each occurrence has its own id');
});

test('caldav.js createCalDavEvent: a repeating timed event is written in the user\'s zone with its rule', async (t) => {
  const { state, account, calendar } = await fakeServer(t, '');
  await createCalDavEvent(account, calendar, {
    title: 'Standup', start: '2026-10-07T07:00:00.000Z', end: '2026-10-07T07:15:00.000Z', allDay: false,
    timeZone: TZ, repeat: 'weekly', repeatUntil: null,
  });
  const l = lines(state.puts[0].body);
  assert.ok(l.includes('DTSTART;TZID=Europe/Ljubljana:20261007T090000'));
  assert.ok(l.includes('DTEND;TZID=Europe/Ljubljana:20261007T091500'));
  assert.ok(l.includes('RRULE:FREQ=WEEKLY'));
});

test('caldav.js updateCalDavOccurrence: writes one override and replaces it on a second edit, leaving the series alone', async (t) => {
  const { state, account, calendar } = await fakeServer(t);
  const edit = (title) => updateCalDavOccurrence(account, calendar, 'abc', '2026-10-21T07:00:00.000Z', {
    title, start: '2026-10-21T13:00:00.000Z', end: '2026-10-21T14:00:00.000Z', allDay: false, timeZone: TZ,
  });
  await edit('First');
  await edit('Second');
  const l = lines(state.ics);
  assert.equal(l.filter((x) => x === 'RECURRENCE-ID;TZID=Europe/Ljubljana:20261021T090000').length, 1);
  assert.ok(l.includes('SUMMARY:Second') && !l.includes('SUMMARY:First'));
  assert.ok(l.includes('SUMMARY:Moved once'), 'the earlier override of another occurrence stays');
  assert.ok(l.includes('RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T225959Z'), 'series rule untouched');
  assert.ok(state.puts.every((p) => p.url === '/cal/abc.ics'));
});

test('caldav.js deleteCalDavOccurrence: excludes the occurrence in the series\' own form and drops its override', async (t) => {
  const { state, account, calendar } = await fakeServer(t);
  await deleteCalDavOccurrence(account, calendar, 'abc', '2026-10-07T07:00:00.000Z', TZ);
  const l = lines(state.ics);
  assert.ok(l.includes('EXDATE;TZID=Europe/Ljubljana:20261007T090000'));
  assert.ok(!l.some((x) => x.startsWith('RECURRENCE-ID')), 'the override of the deleted occurrence is gone');
  const series = l.slice(l.indexOf('BEGIN:VEVENT'), l.indexOf('END:VEVENT') + 1);
  assert.ok(series.includes('EXDATE;TZID=Europe/Ljubljana:20261007T090000'), 'EXDATE sits inside the series event');
});

test('caldav.js updateCalDavSeries: a title edit keeps times, exclusions, edits and unknown properties', async (t) => {
  const { state, account, calendar } = await fakeServer(t);
  await updateCalDavSeries(account, calendar, 'abc', '2026-10-21T07:00:00.000Z', {
    title: 'Renamed', start: '2026-10-21T07:00:00.000Z', end: '2026-10-21T08:00:00.000Z', allDay: false, timeZone: TZ,
  });
  const l = lines(state.ics);
  assert.ok(l.includes('SUMMARY:Renamed'));
  assert.ok(l.includes('DTSTART;TZID=Europe/Ljubljana:20260902T090000'));
  assert.ok(l.includes('EXDATE;TZID=Europe/Ljubljana:20261014T090000'));
  assert.ok(l.includes('SUMMARY:Moved once'));
  assert.ok(l.includes('CATEGORIES:Work'));
  assert.ok(l.includes('DESCRIPTION:Reminder'), 'the alarm keeps its own description');
  assert.ok(l.includes('RRULE:FREQ=WEEKLY;UNTIL=20261231T225959Z'), 'simple rule rebuilt without the fixed weekday');
});

test('caldav.js updateCalDavSeries: moving the series shifts its start and drops exceptions that no longer line up', async (t) => {
  const { state, account, calendar } = await fakeServer(t);
  // The 21 Oct (Wed) occurrence moved to Thu 22 Oct 10:30-11:30, for all events.
  await updateCalDavSeries(account, calendar, 'abc', '2026-10-21T07:00:00.000Z', {
    title: 'Weekly', start: '2026-10-22T08:30:00.000Z', end: '2026-10-22T09:30:00.000Z', allDay: false, timeZone: TZ,
  });
  const l = lines(state.ics);
  assert.ok(l.includes('DTSTART;TZID=Europe/Ljubljana:20260903T103000'));
  assert.ok(l.includes('DTEND;TZID=Europe/Ljubljana:20260903T113000'));
  assert.ok(!l.some((x) => x.startsWith('EXDATE')));
  assert.ok(!l.some((x) => x.startsWith('RECURRENCE-ID')));
  assert.equal(l.filter((x) => x === 'BEGIN:VEVENT').length, 1);
});

test('caldav.js updateCalDavSeries: choosing "Does not repeat" turns the series into one event', async (t) => {
  const { state, account, calendar } = await fakeServer(t);
  await updateCalDavSeries(account, calendar, 'abc', '2026-09-02T07:00:00.000Z', {
    title: 'Once', start: '2026-09-02T07:00:00.000Z', end: '2026-09-02T08:00:00.000Z', allDay: false, timeZone: TZ,
    repeat: 'none',
  });
  const l = lines(state.ics);
  assert.ok(!l.some((x) => x.startsWith('RRULE') || x.startsWith('EXDATE') || x.startsWith('RECURRENCE-ID')));
});

// ── Google ──

test('calendar.js createGoogleEvent: a repeating event is sent with its zone and rule', async (t) => {
  let sent;
  t.mock.method(axios, 'post', async (url, body) => {
    sent = body;
    return { data: { id: 'e1', summary: body.summary, start: body.start, end: body.end } };
  });
  await createGoogleEvent({ accessToken: 'x' }, 'gcal_p', 'p', '#000', {
    title: 'Standup', start: '2026-10-07T07:00:00.000Z', end: '2026-10-07T07:15:00.000Z', allDay: false,
    timeZone: TZ, recurrence: ['RRULE:FREQ=WEEKLY'],
  });
  assert.deepEqual(sent.start, { dateTime: '2026-10-07T09:00:00', timeZone: TZ });
  assert.deepEqual(sent.recurrence, ['RRULE:FREQ=WEEKLY']);
});

test('calendar.js updateGoogleSeries: patches the series, shifted like the occurrence, keeping its exclusions', async (t) => {
  t.mock.method(axios, 'get', async () => ({
    data: {
      id: 'ser',
      start: { dateTime: '2026-09-02T09:00:00+02:00', timeZone: TZ },
      end: { dateTime: '2026-09-02T10:00:00+02:00', timeZone: TZ },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE;TZID=Europe/Ljubljana:20261014T090000'],
    },
  }));
  let patched;
  t.mock.method(axios, 'patch', async (url, body) => {
    patched = { url, body };
    return { data: { id: 'ser', summary: body.summary, start: body.start, end: body.end } };
  });
  await updateGoogleSeries({ accessToken: 'x' }, 'gcal_p', 'p', '#000', 'ser', '2026-10-21T07:00:00.000Z', {
    title: 'Weekly', start: '2026-10-22T08:30:00.000Z', end: '2026-10-22T09:30:00.000Z', allDay: false, timeZone: TZ,
  });
  assert.match(patched.url, /\/events\/ser$/);
  assert.equal(patched.body.start.dateTime, '2026-09-03T10:30:00');
  assert.equal(patched.body.end.dateTime, '2026-09-03T11:30:00');
  assert.deepEqual(patched.body.recurrence, ['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Ljubljana:20261014T090000']);
});

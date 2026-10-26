process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchIcsEvents } from '../src/ics.js';

// Recurring ICS events across the 2026-10-25 DST fall-back.

const FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:a@test
SUMMARY:weekly 0900
DTSTART;TZID=Europe/Ljubljana:20261012T090000
DTEND;TZID=Europe/Ljubljana:20261012T100000
RRULE:FREQ=WEEKLY
END:VEVENT
BEGIN:VEVENT
UID:b@test
SUMMARY:weekly 0030
DTSTART;TZID=Europe/Ljubljana:20261012T003000
DTEND;TZID=Europe/Ljubljana:20261012T013000
RRULE:FREQ=WEEKLY
EXDATE;TZID=Europe/Ljubljana:20261026T003000
END:VEVENT
BEGIN:VEVENT
UID:c@test
SUMMARY:allday weekly
DTSTART;VALUE=DATE:20261011
DTEND;VALUE=DATE:20261012
RRULE:FREQ=WEEKLY
EXDATE;VALUE=DATE:20261101
END:VEVENT
BEGIN:VEVENT
UID:c@test
SUMMARY:allday moved
RECURRENCE-ID;VALUE=DATE:20261018
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261021
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, '\r\n');

async function fetchFeed() {
  const srv = http.createServer((req, res) => res.end(FEED)).listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/`;
    return await fetchIcsEvents({ id: 'f', name: 'f', url }, '2026-10-05T00:00:00Z', '2026-11-07T00:00:00Z');
  } finally {
    srv.close();
  }
}

const local = (iso) => new Date(iso).toLocaleString('sv', { timeZone: 'Europe/Ljubljana' });
const byTitle = (events, title) => events.filter((e) => e.title === title);

test('ics: a weekly 09:00 event stays at 09:00 after the DST change', async () => {
  const starts = byTitle(await fetchFeed(), 'weekly 0900').map((e) => local(e.start));
  assert.ok(starts.includes('2026-10-19 09:00:00'));
  assert.ok(starts.includes('2026-10-26 09:00:00'));
});

test('ics: EXDATE removes an occurrence between local midnight and 01:00', async () => {
  const starts = byTitle(await fetchFeed(), 'weekly 0030').map((e) => local(e.start));
  assert.ok(starts.includes('2026-10-19 00:30:00'));
  assert.ok(!starts.includes('2026-10-26 00:30:00'));
});

test('ics: all-day EXDATE and override apply, and the 25-hour day keeps a 1-day span', async () => {
  const events = await fetchFeed();
  const weekly = byTitle(events, 'allday weekly').map((e) => `${e.start}/${e.end}`);
  assert.deepEqual(weekly, ['2026-10-11/2026-10-12', '2026-10-25/2026-10-26']);
  const moved = byTitle(events, 'allday moved').map((e) => `${e.start}/${e.end}`);
  assert.deepEqual(moved, ['2026-10-20/2026-10-21']);
});

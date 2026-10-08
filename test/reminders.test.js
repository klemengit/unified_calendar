import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedTime,
  fireTime,
  dueReminders,
  pruneSent,
  notificationFor,
  createReminderLoop,
} from '../src/reminders.js';

const TZ = 'Europe/Ljubljana';
const CFG = { minutesBefore: 10, allDayHour: 8, mutedCalendars: [], timeZone: TZ, timeFormat: '24h' };
const at = (iso) => Date.parse(iso);
const meeting = { id: 'g-1', calId: 'gcal_a', title: 'Standup', start: '2026-10-07T12:00:00Z', end: '2026-10-07T12:30:00Z', allDay: false };
const holiday = { id: 'h-1', calId: 'f1', title: 'Holiday', start: '2026-10-08', end: '2026-10-09', allDay: true };

test('zonedTime: wall-clock hour in a zone, on both sides of a DST change', () => {
  assert.equal(zonedTime('2026-10-08', 8, TZ), at('2026-10-08T06:00:00Z')); // CEST, UTC+2
  assert.equal(zonedTime('2026-12-01', 8, TZ), at('2026-12-01T07:00:00Z')); // CET, UTC+1
  assert.equal(zonedTime('2026-10-25', 8, TZ), at('2026-10-25T07:00:00Z')); // the day clocks go back
});

test('fireTime: lead before timed events, the configured hour for all-day ones', () => {
  assert.equal(fireTime(meeting, CFG), at('2026-10-07T11:50:00Z'));
  assert.equal(fireTime(holiday, CFG), at('2026-10-08T06:00:00Z'));
  assert.equal(fireTime(holiday, { ...CFG, allDayHour: null }), null);
});

test('dueReminders: nothing before the fire time, one reminder from then until the start', () => {
  assert.equal(dueReminders([meeting], at('2026-10-07T11:49:59Z'), CFG).length, 0);
  assert.equal(dueReminders([meeting], at('2026-10-07T11:50:00Z'), CFG).length, 1);
  assert.equal(dueReminders([meeting], at('2026-10-07T11:59:00Z'), CFG).length, 1); // late, still useful
  assert.equal(dueReminders([meeting], at('2026-10-07T12:00:00Z'), CFG).length, 0); // started
});

test('dueReminders: a reminder at the start is still sent shortly after it', () => {
  const cfg = { ...CFG, minutesBefore: 0 };
  assert.equal(dueReminders([meeting], at('2026-10-07T12:03:00Z'), cfg).length, 1);
  assert.equal(dueReminders([meeting], at('2026-10-07T12:06:00Z'), cfg).length, 0);
});

test('dueReminders: all-day reminders are dropped once well past their hour', () => {
  assert.equal(dueReminders([holiday], at('2026-10-08T06:30:00Z'), CFG).length, 1);
  assert.equal(dueReminders([holiday], at('2026-10-08T10:00:00Z'), CFG).length, 0);
});

test('dueReminders: skips muted calendars, sent reminders and duplicate events', () => {
  const now = at('2026-10-07T11:55:00Z');
  assert.equal(dueReminders([meeting], now, { ...CFG, mutedCalendars: ['gcal_a'] }).length, 0);
  const [first] = dueReminders([meeting, { ...meeting }], now, CFG);
  assert.equal(dueReminders([meeting, { ...meeting }], now, CFG).length, 1);
  assert.equal(dueReminders([meeting], now, CFG, { [first.key]: Infinity }).length, 0);
  // A moved event is a new reminder.
  const moved = { ...meeting, start: '2026-10-07T12:02:00Z' };
  assert.equal(dueReminders([moved], now, CFG, { [first.key]: Infinity }).length, 1);
});

test('dueReminders: keys hold no event id', () => {
  const [item] = dueReminders([meeting], at('2026-10-07T11:55:00Z'), CFG);
  assert.match(item.key, /^[0-9a-f]{24}$/);
  assert.ok(!item.key.includes('g-1'));
});

test('pruneSent: drops expired records only', () => {
  assert.deepEqual(pruneSent({ a: 10, b: 30 }, 20), { b: 30 });
});

test('notificationFor: title, minutes left, local times and location', () => {
  const [item] = dueReminders([{ ...meeting, location: 'Room 4' }], at('2026-10-07T11:50:00Z'), CFG);
  const n = notificationFor(item, at('2026-10-07T11:50:00Z'), CFG);
  assert.equal(n.title, 'Standup');
  assert.equal(n.body, 'In 10 min · 14:00–14:30 · Room 4');
  assert.equal(n.tag, item.key);
  const [day] = dueReminders([holiday], at('2026-10-08T06:00:00Z'), CFG);
  assert.equal(notificationFor(day, at('2026-10-08T06:00:00Z'), CFG).body, 'Today, all day');
});

test('createReminderLoop: sends each reminder once and records it', async () => {
  let now = at('2026-10-07T11:50:00Z');
  let sent = {};
  const payloads = [];
  let fetches = 0;
  const loop = createReminderLoop({
    now: () => now,
    fetchEvents: async () => { fetches += 1; return [meeting]; },
    getConfig: () => CFG,
    hasSubscribers: () => true,
    send: async (p) => { payloads.push(p); },
    loadSent: () => sent,
    saveSent: (s) => { sent = s; },
  });
  await loop.tick();
  now += 30_000;
  await loop.tick();
  assert.equal(payloads.length, 1);
  assert.equal(fetches, 1, 'events are refetched every few minutes, not every tick');
  assert.equal(Object.keys(sent).length, 1);
});

test('createReminderLoop: does nothing without subscribers', async () => {
  let fetched = false;
  const loop = createReminderLoop({
    fetchEvents: async () => { fetched = true; return []; },
    getConfig: () => CFG,
    hasSubscribers: () => false,
    send: async () => {},
    loadSent: () => ({}),
    saveSent: () => {},
  });
  await loop.tick();
  assert.equal(fetched, false);
});

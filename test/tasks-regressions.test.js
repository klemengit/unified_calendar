process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import ical from 'node-ical';
import { buildVtodoIcal, normalizeVtodo } from '../src/tasks.js';
import { createCalDavEvent, __setRequestFn } from '../src/caldav.js';

const CTX = { listId: 'l1', listName: 'Tasks', listUrl: 'https://dav.example.org/caldav/t/', accountId: 'a1', etag: null };

function roundTrip(fields) {
  const text = buildVtodoIcal('uid-rt', fields);
  const comp = Object.values(ical.parseICS(text)).find((c) => c.type === 'VTODO');
  return { text, task: normalizeVtodo(comp, CTX) };
}

// ── Carriage returns in text values ──────────────────────────────
// Escaping LF but not CR left a raw \r mid-content-line. node-ical's content-line regex cannot
// match across it, so the property was dropped wholesale on read-back, and the same raw byte let a
// value open what looks like a fresh property line.

test('notes pasted with Windows line endings survive a round trip', () => {
  const { task } = roundTrip({ title: 'Ordinary task', notes: 'Line one\r\nLine two' });
  assert.equal(task.notes, 'Line one\nLine two');
});

test('a lone carriage return in notes survives a round trip', () => {
  const { task } = roundTrip({ title: 'Ordinary task', notes: 'Line one\rLine two' });
  assert.equal(task.notes, 'Line one\nLine two');
});

test('a title containing CRLF survives a round trip', () => {
  const { task } = roundTrip({ title: 'First\r\nSecond' });
  assert.equal(task.title, 'First\nSecond');
});

test('no bare carriage return ever reaches the wire', () => {
  const { text } = roundTrip({ title: 'evil\rDUE:20991231T000000Z', notes: 'a\rb\r\nc' });
  assert.doesNotMatch(text, /\r(?!\n)/, 'every CR must be part of a CRLF line terminator');
});

test('a CR in a title cannot smuggle a property past the whitelist', () => {
  const { text, task } = roundTrip({ title: 'evil\rDUE:20991231T000000Z' });

  // The injected text stays inside SUMMARY as escaped data...
  assert.equal(task.due, null, 'no DUE property may be created from the title');
  assert.ok(task.title.includes('DUE:20991231T000000Z'), 'the text stays in the title, as data');

  // ...and there is no DUE content line in the emitted stream at all.
  const lines = text.split('\r\n');
  assert.ok(!lines.some((l) => l.startsWith('DUE')), `unexpected DUE line in:\n${text}`);
});

test('a CR in a category cannot smuggle a property either', () => {
  const { text } = roundTrip({ title: 'Task', categories: ['admin\rPRIORITY:1'] });
  const lines = text.split('\r\n');
  assert.ok(!lines.some((l) => l.startsWith('PRIORITY')), `unexpected PRIORITY line in:\n${text}`);
});

test('ordinary text is still escaped the way it always was', () => {
  const { task } = roundTrip({ title: 'a;b,c\\d', notes: 'semi; comma, slash\\' });
  assert.equal(task.title, 'a;b,c\\d');
  assert.equal(task.notes, 'semi; comma, slash\\');
});

// ── Malformed COMPLETED ──────────────────────────────────────────
// One corrupt value must not throw and take the whole fetch down with it.

function vtodoWith(line) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Open-Xchange', 'BEGIN:VTODO',
    'UID:uid-c', 'DTSTAMP:20260915T100000Z', 'SUMMARY:A task', line,
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

test('an unparseable COMPLETED value degrades to null instead of throwing', () => {
  const comp = Object.values(ical.parseICS(vtodoWith('COMPLETED:not-a-valid-date'))).find((c) => c.type === 'VTODO');
  let task;
  assert.doesNotThrow(() => { task = normalizeVtodo(comp, CTX); });
  assert.equal(task.completedAt, null);
  assert.equal(task.title, 'A task', 'the rest of the task still parses');
});

test('a valid COMPLETED value still parses', () => {
  const comp = Object.values(ical.parseICS(vtodoWith('COMPLETED:20260721T161753Z'))).find((c) => c.type === 'VTODO');
  const task = normalizeVtodo(comp, CTX);
  assert.equal(task.completedAt, '2026-07-21T16:17:53.000Z');
});

// ── The same escaping defect existed on the event path ───────────

test('event descriptions with Windows line endings reach the wire intact', async () => {
  let body = '';
  __setRequestFn((cfg) => {
    body = String(cfg.data || '');
    return Promise.resolve({ status: 201, headers: {}, data: '' });
  });
  try {
    await createCalDavEvent(
      { id: 'a1', username: 'u', password: 'p', displayName: 'u' },
      { id: 'c1', url: 'https://dav.example.org/caldav/c/', color: '#000000' },
      { title: 'Meeting\rInjected', start: '2026-09-15T10:00:00.000Z', end: '2026-09-15T11:00:00.000Z', description: 'a\r\nb' }
    );
  } finally {
    __setRequestFn(null);
  }
  assert.doesNotMatch(body, /\r(?!\n)/, 'no bare CR in the event payload either');
  assert.ok(!body.split('\r\n').some((l) => l.startsWith('Injected')), 'nothing smuggled onto its own line');
});

// ── Priority buckets ─────────────────────────────────────────────
// Open-Xchange keeps only three priority levels and rewrites anything else. Measured against the
// live server on 2026-09-15 by writing each value and reading it back:
//   sent 1,2 -> stored 1 | sent 3,4,5,6 -> stored 5 | sent 7,8,9 -> stored 9 | sent 0 -> stored 0
// buildVtodoIcal collapses to the same buckets so an optimistic value never changes under the user.

test('priority is collapsed to the three buckets the server actually keeps', () => {
  const stored = (p) => roundTrip({ title: 'T', priority: p }).task.priority;
  for (const p of [1, 2]) assert.equal(stored(p), 1, `sent ${p}`);
  for (const p of [3, 4, 5, 6]) assert.equal(stored(p), 5, `sent ${p}`);
  for (const p of [7, 8, 9]) assert.equal(stored(p), 9, `sent ${p}`);
});

test('priority 0 stays unset and emits no PRIORITY line', () => {
  const { text, task } = roundTrip({ title: 'T', priority: 0 });
  assert.equal(task.priority, 0);
  assert.ok(!text.split('\r\n').some((l) => l.startsWith('PRIORITY')));
});

test('a nonsense priority degrades to unset rather than throwing', () => {
  assert.equal(roundTrip({ title: 'T', priority: 'urgent' }).task.priority, 0);
  assert.equal(roundTrip({ title: 'T', priority: 99 }).task.priority, 9);
  assert.equal(roundTrip({ title: 'T', priority: -3 }).task.priority, 0);
});

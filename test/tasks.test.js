process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import ical from 'node-ical';
import { normalizeVtodo, buildVtodoIcal, applyCompletion, parseQuickAdd, resolveListToken } from '../src/tasks.js';

// parseICS() also returns a VCALENDAR meta entry alongside the VTODO one — same shape callers of
// fetchCalDavEvents already filter on (comp.type !== 'VEVENT'), just for VTODO here.
function parseOneVtodo(icalText) {
  const parsed = ical.parseICS(icalText);
  const comp = Object.values(parsed).find((c) => c.type === 'VTODO');
  assert.ok(comp, 'expected a VTODO component in parsed output');
  return comp;
}

const CTX = { listId: 'cdav_1_tasks', listName: 'Tasks', listUrl: 'https://dav.example.org/caldav/tasks/', accountId: 'cdav_1', etag: '"abc123"' };

// ── normalizeVtodo ──

test('normalizeVtodo: full VTODO maps every field', () => {
  const ics = buildVtodoIcal('uid-1', {
    title: 'Renew the parking permit',
    notes: 'Connect bank\naccount, please.',
    due: '2026-09-20',
    dueHasTime: false,
    start: '2026-09-18',
    // A canonical bucket value: the server keeps only 1/5/9, and the collapse has its own tests
    // in tasks-regressions.test.js. Using 5 here keeps this test about field mapping.
    priority: 5,
    categories: ['admin', 'garden'],
    status: 'NEEDS-ACTION',
    percent: 40,
  });
  const comp = parseOneVtodo(ics);
  const task = normalizeVtodo(comp, CTX);

  assert.equal(task.id, 'cdavtodo-uid-1');
  assert.equal(task.uid, 'uid-1');
  assert.equal(task.title, 'Renew the parking permit');
  assert.equal(task.notes, 'Connect bank\naccount, please.');
  assert.equal(task.status, 'NEEDS-ACTION');
  assert.equal(task.completed, false);
  assert.equal(task.completedAt, null);
  assert.equal(task.due, '2026-09-20');
  assert.equal(task.dueHasTime, false);
  assert.equal(task.start, '2026-09-18');
  assert.equal(task.priority, 5);
  assert.equal(task.percent, 40);
  assert.deepEqual(task.categories, ['admin', 'garden']);
  assert.equal(task.listId, CTX.listId);
  assert.equal(task.listName, CTX.listName);
  assert.equal(task.listUrl, CTX.listUrl);
  assert.equal(task.accountId, CTX.accountId);
  assert.equal(task.etag, CTX.etag);
});

test('normalizeVtodo: missing SUMMARY falls back to (no title)', () => {
  const comp = parseOneVtodo(buildVtodoIcal('uid-2', { title: '' }));
  assert.equal(normalizeVtodo(comp, CTX).title, '(no title)');
});

test('normalizeVtodo: missing DESCRIPTION becomes empty string, not null', () => {
  const comp = parseOneVtodo(buildVtodoIcal('uid-3', { title: 'x' }));
  assert.equal(normalizeVtodo(comp, CTX).notes, '');
});

test('normalizeVtodo: DESCRIPTION is trimmed', () => {
  const comp = parseOneVtodo(buildVtodoIcal('uid-4', { title: 'x', notes: '  padded text  ' }));
  // buildVtodoIcal doesn't trim on write, so the round trip exercises normalizeVtodo's own trim.
  assert.equal(normalizeVtodo(comp, CTX).notes, 'padded text');
});

test('normalizeVtodo: bare VTODO with no optional properties at all', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', 'UID:bare-1', 'DTSTAMP:20260915T100000Z', 'SUMMARY:Bare task',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  const task = normalizeVtodo(parseOneVtodo(ics), CTX);
  assert.equal(task.status, 'NEEDS-ACTION');
  assert.equal(task.completed, false);
  assert.equal(task.completedAt, null);
  assert.equal(task.due, null);
  assert.equal(task.dueHasTime, false);
  assert.equal(task.start, null);
  assert.equal(task.priority, 0);
  assert.equal(task.percent, 0);
  assert.deepEqual(task.categories, []);
});

test('normalizeVtodo: DATE-only DUE across a timezone-shifting UTC offset yields the local calendar day', () => {
  // Europe/Ljubljana is UTC+2 in September; a naive toISOString() read would land on the 19th.
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', 'UID:date-only-1', 'DTSTAMP:20260915T100000Z',
    'DUE;VALUE=DATE:20260920', 'SUMMARY:x',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  const task = normalizeVtodo(parseOneVtodo(ics), CTX);
  assert.equal(task.due, '2026-09-20');
  assert.equal(task.dueHasTime, false);
});

test('normalizeVtodo: DATE-TIME DUE yields an ISO UTC string and dueHasTime true', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', 'UID:datetime-1', 'DTSTAMP:20260915T100000Z',
    'DUE:20260920T153000Z', 'SUMMARY:x',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  const task = normalizeVtodo(parseOneVtodo(ics), CTX);
  assert.equal(task.due, '2026-09-20T15:30:00.000Z');
  assert.equal(task.dueHasTime, true);
});

test('normalizeVtodo: STATUS:COMPLETED sets completed true and completedAt from COMPLETED', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', 'UID:completed-1', 'DTSTAMP:20260915T100000Z',
    'STATUS:COMPLETED', 'COMPLETED:20260919T090000Z', 'PERCENT-COMPLETE:100', 'SUMMARY:x',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  const task = normalizeVtodo(parseOneVtodo(ics), CTX);
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.completed, true);
  assert.equal(task.completedAt, '2026-09-19T09:00:00.000Z');
  assert.equal(task.percent, 100);
});

test('normalizeVtodo: IN-PROCESS and CANCELLED statuses pass through, completed stays false', () => {
  for (const status of ['IN-PROCESS', 'CANCELLED']) {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
      'BEGIN:VTODO', `UID:status-${status}`, 'DTSTAMP:20260915T100000Z',
      `STATUS:${status}`, 'SUMMARY:x',
      'END:VTODO', 'END:VCALENDAR',
    ].join('\r\n');
    const task = normalizeVtodo(parseOneVtodo(ics), CTX);
    assert.equal(task.status, status);
    assert.equal(task.completed, false);
  }
});

test('normalizeVtodo: PRIORITY out of range is clamped into 0..9', () => {
  const over = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', 'UID:prio-over', 'DTSTAMP:20260915T100000Z', 'PRIORITY:15', 'SUMMARY:x',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  assert.equal(normalizeVtodo(parseOneVtodo(over), CTX).priority, 9);
});

test('normalizeVtodo: CATEGORIES with blank entries drops the empties', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unified Calendar//EN',
    'BEGIN:VTODO', 'UID:cats-1', 'DTSTAMP:20260915T100000Z',
    'CATEGORIES:admin,, garden ,', 'SUMMARY:x',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  assert.deepEqual(normalizeVtodo(parseOneVtodo(ics), CTX).categories, ['admin', 'garden']);
});

// ── buildVtodoIcal ──

test('buildVtodoIcal: never emits RRULE or RELATED-TO even when the caller passes them', () => {
  const ics = buildVtodoIcal('uid-hostile', {
    title: 'x',
    rrule: 'FREQ=DAILY',
    'RELATED-TO': 'some-other-uid',
    relatedTo: 'some-other-uid',
    RRULE: 'FREQ=WEEKLY',
  });
  assert.ok(!/RRULE/.test(ics), 'must not contain RRULE');
  assert.ok(!/RELATED-TO/.test(ics), 'must not contain RELATED-TO');
});

test('buildVtodoIcal: only whitelisted + structural properties ever appear', () => {
  const ics = buildVtodoIcal('uid-full', {
    title: 'x', notes: 'y', due: '2026-09-20', dueHasTime: false, start: '2026-09-18',
    priority: 5, categories: ['a', 'b'], status: 'NEEDS-ACTION', percent: 50,
    completedAt: '2026-09-19T09:00:00.000Z', created: '2026-01-01T00:00:00.000Z',
  });
  const propNames = ics.split('\r\n')
    .filter((l) => l.includes(':'))
    .map((l) => l.split(/[:;]/)[0]);
  const allowed = new Set([
    'BEGIN', 'END', 'VERSION', 'PRODID', 'UID', 'DTSTAMP', 'CREATED',
    'DUE', 'DTSTART', 'CATEGORIES', 'SUMMARY', 'PRIORITY', 'DESCRIPTION', 'VALARM',
    'STATUS', 'PERCENT-COMPLETE', 'COMPLETED',
  ]);
  for (const name of propNames) assert.ok(allowed.has(name), `unexpected property: ${name}`);
});

test('buildVtodoIcal: structure is BEGIN:VCALENDAR/VTODO ... END:VTODO/VCALENDAR, CRLF-joined', () => {
  const ics = buildVtodoIcal('uid-shape', { title: 'x' });
  assert.ok(ics.includes('\r\n'));
  const lines = ics.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-1), 'END:VCALENDAR');
  assert.ok(lines.includes('BEGIN:VTODO'));
  assert.ok(lines.includes('END:VTODO'));
  assert.ok(lines.includes('UID:uid-shape'));
});

test('buildVtodoIcal: PRIORITY 0 is omitted (0 = unset per RFC 5545)', () => {
  const ics = buildVtodoIcal('uid-p0', { title: 'x', priority: 0 });
  assert.ok(!/^PRIORITY:/m.test(ics));
});

test('buildVtodoIcal: PRIORITY out of range is clamped before writing', () => {
  const ics = buildVtodoIcal('uid-pclamp', { title: 'x', priority: 42 });
  assert.ok(/^PRIORITY:9\r$/m.test(ics));
});

test('buildVtodoIcal: empty categories/notes omit those properties entirely', () => {
  const ics = buildVtodoIcal('uid-empties', { title: 'x', notes: '', categories: [] });
  assert.ok(!/^CATEGORIES:/m.test(ics));
  assert.ok(!/^DESCRIPTION:/m.test(ics));
});

test('buildVtodoIcal: DUE with dueHasTime false writes VALUE=DATE, compact YYYYMMDD', () => {
  const ics = buildVtodoIcal('uid-due-date', { title: 'x', due: '2026-09-20', dueHasTime: false });
  assert.ok(ics.includes('DUE;VALUE=DATE:20260920'));
});

test('buildVtodoIcal: DUE with dueHasTime true writes a plain UTC DATE-TIME line', () => {
  const ics = buildVtodoIcal('uid-due-dt', { title: 'x', due: '2026-09-20T15:30:00.000Z', dueHasTime: true });
  assert.ok(ics.includes('DUE:20260920T153000Z'));
  assert.ok(!ics.includes('VALUE=DATE'));
});

test('buildVtodoIcal: DTSTART as a bare YYYY-MM-DD infers VALUE=DATE', () => {
  const ics = buildVtodoIcal('uid-start-date', { title: 'x', start: '2026-09-18' });
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260918'));
});

test('buildVtodoIcal: DTSTART as a full ISO string infers a DATE-TIME line', () => {
  const ics = buildVtodoIcal('uid-start-dt', { title: 'x', start: '2026-09-18T08:00:00.000Z' });
  assert.ok(ics.includes('DTSTART:20260918T080000Z'));
});

test('buildVtodoIcal: escapes commas/semicolons/backslashes/newlines in SUMMARY, DESCRIPTION, CATEGORIES', () => {
  const ics = buildVtodoIcal('uid-esc', {
    title: 'Buy milk, eggs; bread \\ butter',
    notes: 'Line one\nLine two, with; stuff\\here',
    categories: ['a,weird', 'b;cat'],
  });
  assert.ok(ics.includes('SUMMARY:Buy milk\\, eggs\\; bread \\\\ butter'));
  assert.ok(ics.includes('DESCRIPTION:Line one\\nLine two\\, with\\; stuff\\\\here'));
  assert.ok(ics.includes('CATEGORIES:a\\,weird,b\\;cat'));
});

test('buildVtodoIcal: CREATED and COMPLETED are only emitted when provided', () => {
  const withNeither = buildVtodoIcal('uid-neither', { title: 'x' });
  assert.ok(!/^CREATED:/m.test(withNeither));
  assert.ok(!/^COMPLETED:/m.test(withNeither));

  const withBoth = buildVtodoIcal('uid-both', {
    title: 'x', created: '2026-01-01T00:00:00.000Z', completedAt: '2026-09-19T09:00:00.000Z',
  });
  assert.ok(/^CREATED:20260101T000000Z\r$/m.test(withBoth));
  assert.ok(/^COMPLETED:20260919T090000Z\r$/m.test(withBoth));
});

test('buildVtodoIcal: STATUS defaults to NEEDS-ACTION and PERCENT-COMPLETE defaults to 0', () => {
  const ics = buildVtodoIcal('uid-defaults', { title: 'x' });
  assert.ok(ics.includes('STATUS:NEEDS-ACTION'));
  assert.ok(ics.includes('PERCENT-COMPLETE:0'));
});

// ── round trip: buildVtodoIcal -> node-ical parse -> normalizeVtodo ──

test('round trip preserves every whitelisted field', () => {
  const fields = {
    title: 'Round trip, with escaping; and\nnewlines',
    notes: 'Notes with a comma, a semicolon; and\nnewlines',
    due: '2026-09-25',
    dueHasTime: false,
    start: '2026-09-20',
    priority: 9, // canonical bucket; see the collapse tests in tasks-regressions.test.js
    categories: ['errands', 'reading'],
    status: 'NEEDS-ACTION',
    percent: 65,
  };
  const ics = buildVtodoIcal('roundtrip-uid', fields);
  const task = normalizeVtodo(parseOneVtodo(ics), CTX);

  assert.equal(task.uid, 'roundtrip-uid');
  assert.equal(task.title, fields.title);
  assert.equal(task.notes, fields.notes);
  assert.equal(task.due, fields.due);
  assert.equal(task.dueHasTime, fields.dueHasTime);
  assert.equal(task.start, fields.start);
  assert.equal(task.priority, fields.priority);
  assert.deepEqual(task.categories, fields.categories);
  assert.equal(task.status, fields.status);
  assert.equal(task.percent, fields.percent);
});

test('round trip preserves a DATE-TIME due and a completed task', () => {
  const fields = {
    title: 'Time-sensitive',
    due: '2026-09-25T14:00:00.000Z',
    dueHasTime: true,
    status: 'COMPLETED',
    percent: 100,
    completedAt: '2026-09-19T09:00:00.000Z',
  };
  const ics = buildVtodoIcal('roundtrip-dt-uid', fields);
  const task = normalizeVtodo(parseOneVtodo(ics), CTX);

  assert.equal(task.due, fields.due);
  assert.equal(task.dueHasTime, true);
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.completed, true);
  assert.equal(task.completedAt, fields.completedAt);
  assert.equal(task.percent, 100);
});

// ── applyCompletion ──

test('applyCompletion: completed=true sets STATUS/PERCENT-COMPLETE/COMPLETED and carries other fields', () => {
  const task = {
    title: 'Task A', notes: 'notes', due: '2026-09-20', dueHasTime: false, start: null,
    priority: 4, categories: ['admin'], status: 'NEEDS-ACTION', percent: 0, completedAt: null,
  };
  const fields = applyCompletion(task, true, new Date('2026-09-19T09:00:00.000Z'));
  assert.equal(fields.status, 'COMPLETED');
  assert.equal(fields.percent, 100);
  assert.equal(fields.completedAt, '2026-09-19T09:00:00.000Z');
  assert.equal(fields.title, 'Task A');
  assert.equal(fields.notes, 'notes');
  assert.equal(fields.due, '2026-09-20');
  assert.equal(fields.priority, 4);
  assert.deepEqual(fields.categories, ['admin']);
});

test('applyCompletion: completed=false resets STATUS/PERCENT-COMPLETE and drops COMPLETED', () => {
  const task = {
    title: 'Task B', notes: '', due: null, dueHasTime: false, start: null,
    priority: 0, categories: [], status: 'COMPLETED', percent: 100, completedAt: '2026-09-19T09:00:00.000Z',
  };
  const fields = applyCompletion(task, false, new Date('2026-09-20T09:00:00.000Z'));
  assert.equal(fields.status, 'NEEDS-ACTION');
  assert.equal(fields.percent, 0);
  assert.equal(fields.completedAt, undefined);

  // And feeding it through buildVtodoIcal must not emit a stale COMPLETED line.
  const ics = buildVtodoIcal('uid-uncomplete', fields);
  assert.ok(!/^COMPLETED:/m.test(ics));
  assert.ok(ics.includes('STATUS:NEEDS-ACTION'));
  assert.ok(ics.includes('PERCENT-COMPLETE:0'));
});

test('applyCompletion: accepts an ISO string for `now`, not just a Date', () => {
  const task = { title: 'x', notes: '', due: null, dueHasTime: false, start: null, priority: 0, categories: [] };
  const fields = applyCompletion(task, true, '2026-09-19T09:00:00.000Z');
  assert.equal(fields.completedAt, '2026-09-19T09:00:00.000Z');
});

// ── parseQuickAdd ──

const NOW_WED = new Date('2026-09-16T08:00:00.000Z'); // Wednesday, 2026-09-16, Europe/Ljubljana (UTC+2)
const NOW_MON = new Date('2026-09-14T08:00:00.000Z'); // Monday, 2026-09-14

test('parseQuickAdd: plain text with no tokens is the whole title', () => {
  const result = parseQuickAdd('call the bank', { now: NOW_WED });
  assert.equal(result.title, 'call the bank');
  assert.deepEqual(result.categories, []);
  assert.equal(result.priority, 0);
  assert.equal(result.due, null);
  assert.equal(result.dueHasTime, false);
});

test('parseQuickAdd: full grammar example from the spec', () => {
  const result = parseQuickAdd('call the bank @admin due:friday !1', { now: NOW_WED });
  assert.equal(result.title, 'call the bank');
  assert.deepEqual(result.categories, ['admin']);
  assert.equal(result.priority, 1);
  // Wed 2026-09-16 -> next Friday is 2026-09-18.
  assert.equal(result.due, '2026-09-18');
});

test('parseQuickAdd: throws on an empty title', () => {
  assert.throws(() => parseQuickAdd('', { now: NOW_WED }), /task needs a title/);
  assert.throws(() => parseQuickAdd('   ', { now: NOW_WED }), /task needs a title/);
  assert.throws(() => parseQuickAdd('@admin !2 due:today', { now: NOW_WED }), /task needs a title/);
});

test('parseQuickAdd: multiple categories are all collected, in order', () => {
  const result = parseQuickAdd('fix the bug @workflow @reading @research', { now: NOW_WED });
  assert.deepEqual(result.categories, ['workflow', 'reading', 'research']);
  assert.equal(result.title, 'fix the bug');
});

test('parseQuickAdd: category charset is [A-Za-z0-9_-]+; anything else is not a category token', () => {
  const result = parseQuickAdd('note @good_one-2 @bad! @ just text', { now: NOW_WED });
  assert.deepEqual(result.categories, ['good_one-2']);
  // "@bad!" and lone "@" are not valid category tokens, so both stay in the title verbatim.
  assert.equal(result.title, 'note @bad! @ just text');
});

test('parseQuickAdd: !N priority, N must be a single digit 1-9', () => {
  for (let n = 1; n <= 9; n++) {
    const result = parseQuickAdd(`task !${n}`, { now: NOW_WED });
    assert.equal(result.priority, n, `!${n} should set priority ${n}`);
    assert.equal(result.title, 'task');
  }
});

test('parseQuickAdd: !0 and multi-digit !N are not priority tokens (0 and 10+ are out of range)', () => {
  const zero = parseQuickAdd('task !0', { now: NOW_WED });
  assert.equal(zero.priority, 0);
  assert.equal(zero.title, 'task !0');

  const ten = parseQuickAdd('task !10', { now: NOW_WED });
  assert.equal(ten.priority, 0);
  assert.equal(ten.title, 'task !10');
});

test('parseQuickAdd: last !N wins when repeated', () => {
  const result = parseQuickAdd('task !2 more text !7', { now: NOW_WED });
  assert.equal(result.priority, 7);
  assert.equal(result.title, 'task more text');
});

test('parseQuickAdd: !important is not a priority token and stays in the title verbatim', () => {
  const result = parseQuickAdd('email me@example.com about the !important thing', { now: NOW_WED });
  assert.equal(result.priority, 0);
  assert.equal(result.title, 'email me@example.com about the !important thing');
  assert.deepEqual(result.categories, []);
});

test('parseQuickAdd: an embedded URL with !N-shaped suffix is not mangled', () => {
  const result = parseQuickAdd('check http://x/y!2 later', { now: NOW_WED });
  assert.equal(result.title, 'check http://x/y!2 later');
  assert.equal(result.priority, 0);
});

test('parseQuickAdd: due:today and due:tomorrow', () => {
  assert.equal(parseQuickAdd('x due:today', { now: NOW_WED }).due, '2026-09-16');
  assert.equal(parseQuickAdd('x due:TODAY', { now: NOW_WED }).due, '2026-09-16');
  assert.equal(parseQuickAdd('x due:tomorrow', { now: NOW_WED }).due, '2026-09-17');
});

test('parseQuickAdd: weekday name asked on that same weekday rolls to next week, not today', () => {
  // NOW_MON is a Monday.
  const result = parseQuickAdd('x due:monday', { now: NOW_MON });
  assert.equal(result.due, '2026-09-21'); // the following Monday, not 2026-09-14
});

test('parseQuickAdd: weekday names, full and 3-letter, case-insensitive', () => {
  // NOW_WED is Wednesday 2026-09-16.
  assert.equal(parseQuickAdd('x due:friday', { now: NOW_WED }).due, '2026-09-18');
  assert.equal(parseQuickAdd('x due:FRI', { now: NOW_WED }).due, '2026-09-18');
  assert.equal(parseQuickAdd('x due:Mon', { now: NOW_WED }).due, '2026-09-21');
  assert.equal(parseQuickAdd('x due:sunday', { now: NOW_WED }).due, '2026-09-20');
});

test('parseQuickAdd: due:YYYY-MM-DD literal', () => {
  assert.equal(parseQuickAdd('x due:2027-01-05', { now: NOW_WED }).due, '2027-01-05');
});

test('parseQuickAdd: due:YYYY-MM-DD with an invalid calendar date is left unparsed', () => {
  const result = parseQuickAdd('x due:2027-02-30', { now: NOW_WED });
  assert.equal(result.due, null);
  assert.equal(result.title, 'x due:2027-02-30');
});

test('parseQuickAdd: due:+Nd and due:+Nw offsets', () => {
  assert.equal(parseQuickAdd('x due:+3d', { now: NOW_WED }).due, '2026-09-19');
  assert.equal(parseQuickAdd('x due:+2w', { now: NOW_WED }).due, '2026-09-30');
  assert.equal(parseQuickAdd('x due:+0d', { now: NOW_WED }).due, '2026-09-16');
});

test('parseQuickAdd: Slovenian D.M. with no year rolls into next year once the date has passed', () => {
  // NOW_WED = 2026-09-16. A date earlier in the year than today has passed -> next year.
  const past = parseQuickAdd('x due:1.3.', { now: NOW_WED });
  assert.equal(past.due, '2027-03-01');

  // A date later in the year than today has not passed -> this year.
  const future = parseQuickAdd('x due:25.12.', { now: NOW_WED });
  assert.equal(future.due, '2026-12-25');
});

test('parseQuickAdd: Slovenian D.M. equal to today counts as this year, not "passed"', () => {
  const result = parseQuickAdd('x due:16.9.', { now: NOW_WED });
  assert.equal(result.due, '2026-09-16');
});

test('parseQuickAdd: Slovenian D.M.YYYY literal, past or future, is taken as given', () => {
  assert.equal(parseQuickAdd('x due:1.3.2020', { now: NOW_WED }).due, '2020-03-01');
  assert.equal(parseQuickAdd('x due:5.11.2030', { now: NOW_WED }).due, '2030-11-05');
});

test('parseQuickAdd: Slovenian D.M. single- and double-digit day/month both parse', () => {
  assert.equal(parseQuickAdd('x due:5.3.2027', { now: NOW_WED }).due, '2027-03-05');
  assert.equal(parseQuickAdd('x due:05.03.2027', { now: NOW_WED }).due, '2027-03-05');
});

test('parseQuickAdd: an unparseable due: token is left verbatim in the title, due stays null', () => {
  const result = parseQuickAdd('x due:someday', { now: NOW_WED });
  assert.equal(result.due, null);
  assert.equal(result.title, 'x due:someday');
});

test('parseQuickAdd: multiple due: tokens, the last valid one wins', () => {
  const result = parseQuickAdd('x due:today due:tomorrow', { now: NOW_WED });
  assert.equal(result.due, '2026-09-17');
});

test('parseQuickAdd: a later unparseable due: token does not clear an earlier valid one', () => {
  const result = parseQuickAdd('x due:today due:someday', { now: NOW_WED });
  assert.equal(result.due, '2026-09-16');
  assert.ok(result.title.includes('due:someday'));
});

test('parseQuickAdd: whitespace is collapsed in the title', () => {
  const result = parseQuickAdd('  call   the    bank   ', { now: NOW_WED });
  assert.equal(result.title, 'call the bank');
});

test('parseQuickAdd: dueHasTime is always false', () => {
  assert.equal(parseQuickAdd('x due:today', { now: NOW_WED }).dueHasTime, false);
  assert.equal(parseQuickAdd('x', { now: NOW_WED }).dueHasTime, false);
});

// ── parseQuickAdd: +list token ──

test('parseQuickAdd: no +token gives listToken null', () => {
  assert.equal(parseQuickAdd('Call dentist', { now: NOW_WED }).listToken, null);
});

test('parseQuickAdd: +name is taken out of the title and returned as listToken', () => {
  const result = parseQuickAdd('Prune the apple tree +garden due:friday', { now: NOW_WED });
  assert.equal(result.title, 'Prune the apple tree');
  assert.equal(result.listToken, 'garden');
  assert.equal(result.due, '2026-09-18');
});

test('parseQuickAdd: +token keeps hyphens and diacritics as typed', () => {
  assert.equal(parseQuickAdd('x +home-repairs', { now: NOW_WED }).listToken, 'home-repairs');
  assert.equal(parseQuickAdd('x +čitanje', { now: NOW_WED }).listToken, 'čitanje');
});

test('parseQuickAdd: +token must start with a letter, so phone numbers and +3d stay in the title', () => {
  const result = parseQuickAdd('Call dentist +15555550100 +3d', { now: NOW_WED });
  assert.equal(result.listToken, null);
  assert.equal(result.title, 'Call dentist +15555550100 +3d');
});

test('parseQuickAdd: a lone + or a + inside a word is not a list token', () => {
  const result = parseQuickAdd('C++ and + more', { now: NOW_WED });
  assert.equal(result.listToken, null);
  assert.equal(result.title, 'C++ and + more');
});

test('parseQuickAdd: two +list tokens throw rather than silently picking one', () => {
  assert.throws(() => parseQuickAdd('x +garden +errands', { now: NOW_WED }), /one \+list/);
});

test('parseQuickAdd: a +token alone leaves no title and throws', () => {
  assert.throws(() => parseQuickAdd('+garden', { now: NOW_WED }), /task needs a title/);
});

// ── resolveListToken ──

const ERRANDS = { id: 'cdav_1_tasks', name: 'Errands' };
const GARDEN = { id: 'cdav_1_garden', name: 'Garden' };
const READING = { id: 'cdav_1_reading', name: 'Reading' };
const LISTS = [ERRANDS, GARDEN, READING];

test('resolveListToken: exact name, case-insensitive', () => {
  assert.equal(resolveListToken('garden', LISTS).list, GARDEN);
  assert.equal(resolveListToken('GARDEN', LISTS).list, GARDEN);
});

test('resolveListToken: a unique prefix matches', () => {
  assert.equal(resolveListToken('gar', LISTS).list, GARDEN);
  assert.equal(resolveListToken('r', LISTS).list, READING);
});

test('resolveListToken: diacritics are ignored on both sides', () => {
  const lists = [{ id: 'cdav_1_books', name: 'Čitanje' }, ERRANDS];
  assert.equal(resolveListToken('citanje', lists).list.id, 'cdav_1_books');
  assert.equal(resolveListToken('čit', lists).list.id, 'cdav_1_books');
  assert.equal(resolveListToken('ERRÄNDS', lists).list, ERRANDS);
});

test('resolveListToken: a multi-word name matches with hyphens', () => {
  const lists = [{ id: 'cdav_1_home', name: 'Home  Repairs' }, ERRANDS];
  assert.equal(resolveListToken('home-repairs', lists).list.id, 'cdav_1_home');
  assert.equal(resolveListToken('home-r', lists).list.id, 'cdav_1_home');
});

test('resolveListToken: an exact name wins over a longer name it is also a prefix of', () => {
  const lists = [{ id: 'cdav_1_gt', name: 'Garden Tools' }, GARDEN];
  assert.equal(resolveListToken('garden', lists).list, GARDEN);
});

test('resolveListToken: an ambiguous prefix is an error naming only the matching lists', () => {
  const lists = [...LISTS, { id: 'cdav_1_groceries', name: 'Groceries' }];
  const result = resolveListToken('g', lists);
  assert.equal(result.list, undefined);
  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(result.candidates, ['Garden', 'Groceries']);
  assert.match(result.error, /\+g/);
  assert.match(result.error, /Garden, Groceries/);
  assert.doesNotMatch(result.error, /Errands|cdav_/);
});

test('resolveListToken: an unknown token is an error naming every list, by name only', () => {
  const result = resolveListToken('work', LISTS);
  assert.equal(result.list, undefined);
  assert.equal(result.reason, 'unknown');
  assert.deepEqual(result.candidates, ['Errands', 'Garden', 'Reading']);
  assert.match(result.error, /\+work/);
  assert.match(result.error, /Errands, Garden, Reading/);
  assert.doesNotMatch(result.error, /cdav_/);
});

test('resolveListToken: two lists with the same name are ambiguous, not a silent first pick', () => {
  const lists = [GARDEN, { id: 'cdav_2_garden', name: 'Garden' }];
  assert.equal(resolveListToken('garden', lists).reason, 'ambiguous');
});

test('resolveListToken: no lists at all is unknown, with a message that says so', () => {
  const result = resolveListToken('garden', []);
  assert.equal(result.reason, 'unknown');
  assert.match(result.error, /no task list/i);
});

test('resolveListToken: a name getter lets callers pass {account, list} entries', () => {
  const entries = LISTS.map((list) => ({ account: { id: 'cdav_1' }, list }));
  const result = resolveListToken('read', entries, (e) => e.list.name);
  assert.equal(result.list.list, READING);
});

process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';

const modelPath = fileURLToPath(new URL('../plugin/TaskModel.js', import.meta.url));
function load() {
  return loadQmlScript(modelPath);
}

// Local noon, 2026-09-15 -- deliberately not midnight, so "today" math can't accidentally
// depend on nowMs itself sitting on a day boundary. Europe/Ljubljana is UTC+2 (CEST) on this date.
const NOW_MS = new Date(2026, 8, 15, 12, 0, 0).getTime();

// A Task-shaped plain object (see SPEC.md) with sane defaults, overridden per test. Kept local
// to this file rather than added to test-support/fixtures.js, which is outside this unit.
let taskCounter = 0;
function task(overrides) {
  taskCounter += 1;
  const base = {
    id: `cdavtodo-${taskCounter}`,
    uid: `uid-${taskCounter}`,
    title: 'Task',
    notes: '',
    status: 'NEEDS-ACTION',
    completed: false,
    completedAt: null,
    due: null,
    dueHasTime: false,
    start: null,
    priority: 0,
    percent: 0,
    categories: [],
    listId: 'cdav_1_tasks',
    listName: 'Tasks',
    listUrl: 'https://dav.example.org/caldav/tasks/',
    accountId: 'cdav_1',
    etag: '"abc123"',
  };
  return Object.assign(base, overrides || {});
}

// ---- dueBucket ----------------------------------------------------------------------------

test('dueBucket: null due is "none"', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: null }), NOW_MS), 'none');
});

test('dueBucket: malformed due string degrades to "none" instead of throwing', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: 'not-a-date' }), NOW_MS), 'none');
});

test('dueBucket: non-string due (stale cache shape) degrades to "none"', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: 1234567 }), NOW_MS), 'none');
});

test('dueBucket: date-only due equal to today is "today"', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: '2026-09-15' }), NOW_MS), 'today');
});

test('dueBucket: date-only due yesterday is "overdue" for an open task', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: '2026-09-14' }), NOW_MS), 'overdue');
});

test('dueBucket: a COMPLETED task is never overdue, even with a past due date', () => {
  const m = load();
  const t = task({ due: '2026-09-01', status: 'COMPLETED', completed: true });
  assert.equal(m.dueBucket(t, NOW_MS), 'later');
});

test('dueBucket: completed-only via the `completed` flag (status missing/stale) is also never overdue', () => {
  const m = load();
  const t = task({ due: '2026-09-01', status: undefined, completed: true });
  assert.equal(m.dueBucket(t, NOW_MS), 'later');
});

test('dueBucket: due exactly 7 days out is "week" (inclusive boundary)', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: '2026-09-22' }), NOW_MS), 'week');
});

test('dueBucket: due 8 days out is "later"', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: '2026-09-23' }), NOW_MS), 'later');
});

test('dueBucket: due tomorrow is "week"', () => {
  const m = load();
  assert.equal(m.dueBucket(task({ due: '2026-09-16' }), NOW_MS), 'week');
});

// ---- timezone: local date comparison, not UTC ----------------------------------------------
// Europe/Ljubljana is UTC+2 (CEST) on 2026-09-15. NOW_MS is local noon that day.

test('dueBucket: full ISO due whose UTC date is "yesterday" but local date is today is NOT overdue', () => {
  const m = load();
  // 2026-09-14T23:15:00Z + 2h = 2026-09-15T01:15 local -- due locally TODAY, despite the ISO
  // string's UTC date component reading "2026-09-14" (which would read as "yesterday" under a
  // naive UTC-date comparison and wrongly mark this task overdue).
  const t = task({ due: '2026-09-14T23:15:00Z', dueHasTime: true });
  assert.equal(m.dueBucket(t, NOW_MS), 'today');
});

test('dueBucket: full ISO due whose UTC date is "today" but local date is tomorrow is NOT today', () => {
  const m = load();
  // 2026-09-15T22:30:00Z + 2h = 2026-09-16T00:30 local -- due locally TOMORROW, despite the ISO
  // string's UTC date component reading "2026-09-15" (which would read as "today" under a naive
  // UTC-date comparison).
  const t = task({ due: '2026-09-15T22:30:00Z', dueHasTime: true });
  assert.equal(m.dueBucket(t, NOW_MS), 'week');
});

// ---- filterTasks ----------------------------------------------------------------------------

test('filterTasks: status "open" keeps everything not COMPLETED', () => {
  const m = load();
  const tasks = [
    task({ id: 'a', status: 'NEEDS-ACTION' }),
    task({ id: 'b', status: 'IN-PROCESS' }),
    task({ id: 'c', status: 'CANCELLED' }),
    task({ id: 'd', status: undefined }),
    task({ id: 'e', status: 'COMPLETED', completed: true }),
  ];
  const out = m.filterTasks(tasks, { status: 'open', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.deepEqual(out.map((t) => t.id), ['a', 'b', 'c', 'd']);
});

test('filterTasks: status "done" keeps only COMPLETED', () => {
  const m = load();
  const tasks = [task({ id: 'a', status: 'NEEDS-ACTION' }), task({ id: 'b', status: 'COMPLETED', completed: true })];
  const out = m.filterTasks(tasks, { status: 'done', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.deepEqual(out.map((t) => t.id), ['b']);
});

test('filterTasks: status "all" keeps everything', () => {
  const m = load();
  const tasks = [task({ id: 'a', status: 'NEEDS-ACTION' }), task({ id: 'b', status: 'COMPLETED', completed: true })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.equal(out.length, 2);
});

test('filterTasks: missing filters object defaults to status "open"', () => {
  const m = load();
  const tasks = [task({ id: 'a', status: 'NEEDS-ACTION' }), task({ id: 'b', status: 'COMPLETED', completed: true })];
  const out = m.filterTasks(tasks, undefined, NOW_MS);
  assert.deepEqual(out.map((t) => t.id), ['a']);
});

test('filterTasks: empty buckets array means no bucket filtering', () => {
  const m = load();
  const tasks = [task({ id: 'a', due: '2026-09-14' }), task({ id: 'b', due: null })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.equal(out.length, 2);
});

test('filterTasks: buckets keeps only matching dueBucket values', () => {
  const m = load();
  const tasks = [
    task({ id: 'overdue', due: '2026-09-14' }),
    task({ id: 'today', due: '2026-09-15' }),
    task({ id: 'none', due: null }),
  ];
  const out = m.filterTasks(tasks, { status: 'all', buckets: ['overdue', 'today'], categories: [], search: '' }, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['overdue', 'today']
  );
});

test('filterTasks: categories is OR (any listed category matches), not AND', () => {
  const m = load();
  const tasks = [
    task({ id: 'a', categories: ['admin'] }),
    task({ id: 'b', categories: ['research'] }),
    task({ id: 'c', categories: ['admin', 'research'] }),
    task({ id: 'd', categories: ['workflow'] }),
  ];
  const out = m.filterTasks(
    tasks,
    { status: 'all', buckets: [], categories: ['admin', 'research'], search: '' },
    NOW_MS
  );
  assert.deepEqual(
    out.map((t) => t.id).sort(),
    ['a', 'b', 'c']
  );
});

test('filterTasks: categories filter is case-insensitive', () => {
  const m = load();
  const tasks = [task({ id: 'a', categories: ['Admin'] })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: ['admin'], search: '' }, NOW_MS);
  assert.equal(out.length, 1);
});

test('filterTasks: empty categories array means no category filtering', () => {
  const m = load();
  const tasks = [task({ id: 'a', categories: [] }), task({ id: 'b', categories: ['x'] })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.equal(out.length, 2);
});

test('filterTasks: search matches title, case-insensitive, substring', () => {
  const m = load();
  const tasks = [task({ id: 'a', title: 'Renew the parking permit' }), task({ id: 'b', title: 'Call dentist' })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: [], search: 'PARKING' }, NOW_MS);
  assert.deepEqual(out.map((t) => t.id), ['a']);
});

test('filterTasks: search matches notes too', () => {
  const m = load();
  const tasks = [task({ id: 'a', title: 'x', notes: 'Connect bank account' }), task({ id: 'b', title: 'y', notes: '' })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: [], search: 'bank' }, NOW_MS);
  assert.deepEqual(out.map((t) => t.id), ['a']);
});

test('filterTasks: whitespace-only search means no search filtering', () => {
  const m = load();
  const tasks = [task({ id: 'a', title: 'x' }), task({ id: 'b', title: 'y' })];
  const out = m.filterTasks(tasks, { status: 'all', buckets: [], categories: [], search: '   ' }, NOW_MS);
  assert.equal(out.length, 2);
});

test('filterTasks: all filters combine with AND', () => {
  const m = load();
  const tasks = [
    task({ id: 'match', status: 'NEEDS-ACTION', due: '2026-09-14', categories: ['admin'], title: 'Bank thing' }),
    task({ id: 'wrong-bucket', status: 'NEEDS-ACTION', due: '2026-09-15', categories: ['admin'], title: 'Bank thing' }),
    task({ id: 'wrong-category', status: 'NEEDS-ACTION', due: '2026-09-14', categories: ['research'], title: 'Bank thing' }),
    task({ id: 'wrong-search', status: 'NEEDS-ACTION', due: '2026-09-14', categories: ['admin'], title: 'Dentist' }),
    task({ id: 'wrong-status', status: 'COMPLETED', completed: true, due: '2026-09-14', categories: ['admin'], title: 'Bank thing' }),
  ];
  const out = m.filterTasks(
    tasks,
    { status: 'open', buckets: ['overdue'], categories: ['admin'], search: 'bank' },
    NOW_MS
  );
  assert.deepEqual(out.map((t) => t.id), ['match']);
});

test('filterTasks: defensive against null/undefined tasks array and null entries', () => {
  const m = load();
  assert.deepEqual(m.filterTasks(null, { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS), []);
  assert.deepEqual(m.filterTasks(undefined, { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS), []);
  const out = m.filterTasks([null, task({ id: 'a' })], { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.deepEqual(out.map((t) => t.id), ['a']);
});

test('filterTasks: task with missing categories field is treated as uncategorized', () => {
  const m = load();
  const t = task({ id: 'a' });
  delete t.categories;
  const out = m.filterTasks([t], { status: 'all', buckets: [], categories: ['admin'], search: '' }, NOW_MS);
  assert.equal(out.length, 0);
  const unfiltered = m.filterTasks([t], { status: 'all', buckets: [], categories: [], search: '' }, NOW_MS);
  assert.equal(unfiltered.length, 1);
});

// ---- sortTasks ------------------------------------------------------------------------------

test('sortTasks: overdue, then due soonest, then no due date, for open tasks', () => {
  const m = load();
  const tasks = [
    task({ id: 'none', due: null }),
    task({ id: 'later', due: '2026-09-30' }),
    task({ id: 'overdue', due: '2026-09-01' }),
    task({ id: 'today', due: '2026-09-15' }),
  ];
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['overdue', 'today', 'later', 'none']
  );
});

test('sortTasks: completed tasks always sort after open ones, regardless of due date urgency', () => {
  const m = load();
  const tasks = [
    task({ id: 'done-overdue', due: '2026-01-01', status: 'COMPLETED', completed: true }),
    task({ id: 'open-no-due', due: null }),
  ];
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['open-no-due', 'done-overdue']
  );
});

test('sortTasks: within the same bucket, orders by exact due instant (time-of-day breaks day ties)', () => {
  const m = load();
  const tasks = [
    task({ id: 'later', due: '2026-09-16T18:00:00Z', dueHasTime: true }),
    task({ id: 'earlier', due: '2026-09-16T06:00:00Z', dueHasTime: true }),
  ];
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['earlier', 'later']
  );
});

test('sortTasks: priority breaks ties (1 highest, 0/unset sorts last)', () => {
  const m = load();
  const tasks = [
    task({ id: 'unset', due: '2026-09-15', priority: 0 }),
    task({ id: 'low', due: '2026-09-15', priority: 5 }),
    task({ id: 'high', due: '2026-09-15', priority: 1 }),
  ];
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['high', 'low', 'unset']
  );
});

test('sortTasks: title breaks ties, case-insensitively', () => {
  const m = load();
  const tasks = [
    task({ id: 'b', due: '2026-09-15', priority: 3, title: 'banana' }),
    task({ id: 'a', due: '2026-09-15', priority: 3, title: 'Apple' }),
  ];
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['a', 'b']
  );
});

test('sortTasks: stable -- equal-key tasks keep their original relative order', () => {
  const m = load();
  const tasks = [
    task({ id: 'first', due: '2026-09-15', priority: 2, title: 'Same' }),
    task({ id: 'second', due: '2026-09-15', priority: 2, title: 'Same' }),
    task({ id: 'third', due: '2026-09-15', priority: 2, title: 'Same' }),
  ];
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(
    out.map((t) => t.id),
    ['first', 'second', 'third']
  );
});

test('sortTasks: never mutates the input array', () => {
  const m = load();
  const tasks = [task({ id: 'b', due: '2026-09-30' }), task({ id: 'a', due: '2026-09-01' })];
  const original = tasks.slice();
  const out = m.sortTasks(tasks, NOW_MS);
  assert.deepEqual(tasks, original);
  assert.notEqual(out, tasks);
});

test('sortTasks: defensive against null/undefined tasks array and null entries', () => {
  const m = load();
  assert.deepEqual(m.sortTasks(null, NOW_MS), []);
  assert.deepEqual(m.sortTasks(undefined, NOW_MS), []);
  const out = m.sortTasks([null, task({ id: 'a' })], NOW_MS);
  assert.equal(out.length, 2);
});

// ---- categoryCounts -------------------------------------------------------------------------

test('categoryCounts: aggregates across tasks, sorted by count desc then name asc', () => {
  const m = load();
  const tasks = [
    task({ categories: ['admin', 'research'] }),
    task({ categories: ['admin'] }),
    task({ categories: ['research'] }),
    task({ categories: ['errands'] }),
  ];
  const out = m.categoryCounts(tasks);
  assert.deepEqual(out, [
    { name: 'admin', count: 2 },
    { name: 'research', count: 2 },
    { name: 'errands', count: 1 },
  ]);
});

test('categoryCounts: drops empty/whitespace-only category names', () => {
  const m = load();
  const tasks = [task({ categories: ['admin', '', '  '] })];
  const out = m.categoryCounts(tasks);
  assert.deepEqual(out, [{ name: 'admin', count: 1 }]);
});

test('categoryCounts: tasks with missing/non-array categories are skipped safely', () => {
  const m = load();
  const withMissing = task({});
  delete withMissing.categories;
  const tasks = [withMissing, task({ categories: 'not-an-array' }), task({ categories: ['x'] })];
  const out = m.categoryCounts(tasks);
  assert.deepEqual(out, [{ name: 'x', count: 1 }]);
});

test('categoryCounts: defensive against null/undefined tasks array and null entries', () => {
  const m = load();
  assert.deepEqual(m.categoryCounts(null), []);
  assert.deepEqual(m.categoryCounts(undefined), []);
  assert.deepEqual(m.categoryCounts([null]), []);
});

// ---- overdueCount ---------------------------------------------------------------------------

test('overdueCount: counts only tasks in the overdue bucket', () => {
  const m = load();
  const tasks = [
    task({ id: 'a', due: '2026-09-01' }),
    task({ id: 'b', due: '2026-09-14' }),
    task({ id: 'c', due: '2026-09-15' }),
    task({ id: 'd', due: null }),
  ];
  assert.equal(m.overdueCount(tasks, NOW_MS), 2);
});

test('overdueCount: a COMPLETED task with a past due date is never counted', () => {
  const m = load();
  const tasks = [task({ due: '2026-01-01', status: 'COMPLETED', completed: true })];
  assert.equal(m.overdueCount(tasks, NOW_MS), 0);
});

test('overdueCount: defensive against null/undefined tasks array', () => {
  const m = load();
  assert.equal(m.overdueCount(null, NOW_MS), 0);
  assert.equal(m.overdueCount(undefined, NOW_MS), 0);
});

// ---- summarize --------------------------------------------------------------------------------

test('summarize: open/done/overdue/dueToday counts', () => {
  const m = load();
  const tasks = [
    task({ id: 'a', status: 'NEEDS-ACTION', due: '2026-09-14' }), // open, overdue
    task({ id: 'b', status: 'NEEDS-ACTION', due: '2026-09-15' }), // open, due today
    task({ id: 'c', status: 'COMPLETED', completed: true, due: '2026-09-10' }), // done
    task({ id: 'd', status: 'NEEDS-ACTION', due: null }), // open, no due date
  ];
  assert.deepEqual(m.summarize(tasks, NOW_MS), { open: 3, done: 1, overdue: 1, dueToday: 1 });
});

test('summarize: dueToday excludes COMPLETED tasks due today', () => {
  const m = load();
  const tasks = [task({ status: 'COMPLETED', completed: true, due: '2026-09-15' })];
  assert.deepEqual(m.summarize(tasks, NOW_MS), { open: 0, done: 1, overdue: 0, dueToday: 0 });
});

test('summarize: defensive against null/undefined tasks array and null entries', () => {
  const m = load();
  assert.deepEqual(m.summarize(null, NOW_MS), { open: 0, done: 0, overdue: 0, dueToday: 0 });
  assert.deepEqual(m.summarize(undefined, NOW_MS), { open: 0, done: 0, overdue: 0, dueToday: 0 });
  assert.deepEqual(m.summarize([null], NOW_MS), { open: 0, done: 0, overdue: 0, dueToday: 0 });
});

// ---- task lists -------------------------------------------------------------------------------

const ERRANDS = { id: 'cdav_1_tasks', name: 'Errands', accountId: 'cdav_1', url: '' };
const GARDEN = { id: 'cdav_1_garden', name: 'Garden', accountId: 'cdav_1', url: '' };
const READING = { id: 'cdav_1_reading', name: 'Reading', accountId: 'cdav_1', url: '' };
const LISTS = [ERRANDS, GARDEN, READING];

function listTasks() {
  return [
    task({ title: 'Renew the parking permit', listId: ERRANDS.id, listName: 'Errands' }),
    task({ title: 'Call dentist', listId: ERRANDS.id, listName: 'Errands', status: 'COMPLETED', completed: true }),
    task({ title: 'Prune the apple tree', listId: GARDEN.id, listName: 'Garden' }),
  ];
}

test('filterTasks: lists keeps only tasks in a selected list, OR across lists', () => {
  const m = load();
  const out = m.filterTasks(listTasks(), { status: 'all', lists: [GARDEN.id] }, NOW_MS);
  assert.deepEqual(out.map((t) => t.title), ['Prune the apple tree']);

  const both = m.filterTasks(listTasks(), { status: 'all', lists: [GARDEN.id, ERRANDS.id] }, NOW_MS);
  assert.equal(both.length, 3);
});

test('filterTasks: empty lists array means every list', () => {
  const m = load();
  assert.equal(m.filterTasks(listTasks(), { status: 'all', lists: [] }, NOW_MS).length, 3);
  assert.equal(m.filterTasks(listTasks(), { status: 'all' }, NOW_MS).length, 3);
});

test('filterTasks: an empty list selected on its own shows nothing', () => {
  const m = load();
  assert.deepEqual(m.filterTasks(listTasks(), { status: 'all', lists: [READING.id] }, NOW_MS), []);
});

test('filterTasks: lists combines with status (AND)', () => {
  const m = load();
  const out = m.filterTasks(listTasks(), { status: 'open', lists: [ERRANDS.id] }, NOW_MS);
  assert.deepEqual(out.map((t) => t.title), ['Renew the parking permit']);
});

test('listCounts: one entry per list in server order, empty lists included, counting open tasks only', () => {
  const m = load();
  assert.deepEqual(m.listCounts(listTasks(), LISTS), [
    { id: ERRANDS.id, name: 'Errands', count: 1 },
    { id: GARDEN.id, name: 'Garden', count: 1 },
    { id: READING.id, name: 'Reading', count: 0 },
  ]);
});

test('listCounts: a task in a list the server no longer reports is not counted anywhere', () => {
  const m = load();
  const tasks = [task({ listId: 'cdav_1_gone' })];
  assert.deepEqual(m.listCounts(tasks, [GARDEN]), [{ id: GARDEN.id, name: 'Garden', count: 0 }]);
});

test('listCounts: a list with no name falls back to its id; malformed lists are skipped', () => {
  const m = load();
  const out = m.listCounts([], [{ id: 'cdav_1_x' }, null, { name: 'no id' }]);
  assert.deepEqual(out, [{ id: 'cdav_1_x', name: 'cdav_1_x', count: 0 }]);
});

test('listCounts: defensive against null/undefined inputs', () => {
  const m = load();
  assert.deepEqual(m.listCounts(null, null), []);
  assert.deepEqual(m.listCounts(undefined, LISTS).map((l) => l.count), [0, 0, 0]);
});

test('knownListIds: drops selected ids the server no longer reports, keeps selection order', () => {
  const m = load();
  assert.deepEqual(m.knownListIds([READING.id, 'cdav_1_gone', ERRANDS.id], LISTS), [READING.id, ERRANDS.id]);
  assert.deepEqual(m.knownListIds(null, LISTS), []);
  assert.deepEqual(m.knownListIds([GARDEN.id], null), []);
});

test('quickAddListId: exactly one selected list is sent, otherwise the server default', () => {
  const m = load();
  assert.equal(m.quickAddListId([GARDEN.id]), GARDEN.id);
  assert.equal(m.quickAddListId([]), '');
  assert.equal(m.quickAddListId([GARDEN.id, READING.id]), '');
  assert.equal(m.quickAddListId(null), '');
});

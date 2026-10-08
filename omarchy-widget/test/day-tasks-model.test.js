process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';

const modelPath = fileURLToPath(new URL('../plugin/DayTasksModel.js', import.meta.url));
function load() {
  return loadQmlScript(modelPath);
}

// A Task-shaped plain object (see SPEC.md) with sane defaults, overridden per test. Kept local
// to this file, same reasoning as task-model.test.js's own `task()` helper.
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
    etag: 'abc123',
  };
  return Object.assign(base, overrides || {});
}

// ---- tasksDueOnDay --------------------------------------------------------------------------

test('tasksDueOnDay: matches a plain DATE due value against its day key', () => {
  const m = load();
  const t = task({ due: '2026-09-20' });
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-20'), [t]);
});

test('tasksDueOnDay: matches a due value with a time against its LOCAL day key, not the UTC one', () => {
  const m = load();
  // Per the shared contract, a timed due date is an ISO UTC string. 22:30 UTC on 2026-09-20 is
  // already 2026-09-21 00:30 local (Europe/Ljubljana, UTC+2 on this date) -- the boundary a naive
  // UTC-slice comparison would get wrong.
  const t = task({ due: '2026-09-20T22:30:00Z', dueHasTime: true });
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-21'), [t]);
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-20'), []);
});

test('tasksDueOnDay: includes a COMPLETED task due that day (DayDetails lets it be unticked)', () => {
  const m = load();
  const t = task({ due: '2026-09-20', status: 'COMPLETED', completed: true });
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-20'), [t]);
});

test('tasksDueOnDay: excludes tasks due on other days', () => {
  const m = load();
  const t = task({ due: '2026-09-21' });
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-20'), []);
});

test('tasksDueOnDay: a task with no due date never matches any key', () => {
  const m = load();
  const t = task({ due: null });
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-20'), []);
});

test('tasksDueOnDay: a malformed due string degrades to no match instead of throwing', () => {
  const m = load();
  const t = task({ due: 'not-a-date' });
  assert.doesNotThrow(() => m.tasksDueOnDay([t], '2026-09-20'));
  assert.deepEqual(m.tasksDueOnDay([t], '2026-09-20'), []);
});

test('tasksDueOnDay: preserves input order and tolerates a null/undefined entry in the list', () => {
  const m = load();
  const a = task({ id: 'a', due: '2026-09-20' });
  const b = task({ id: 'b', due: '2026-09-20' });
  assert.deepEqual(m.tasksDueOnDay([a, null, b, undefined], '2026-09-20'), [a, b]);
});

test('tasksDueOnDay: a non-array tasks argument degrades to []', () => {
  const m = load();
  assert.deepEqual(m.tasksDueOnDay(undefined, '2026-09-20'), []);
  assert.deepEqual(m.tasksDueOnDay(null, '2026-09-20'), []);
});

// ---- openDueDayIndex ------------------------------------------------------------------------

test('openDueDayIndex: an open task due that day sets its key to true', () => {
  const m = load();
  const t = task({ due: '2026-09-20' });
  assert.deepEqual(m.openDueDayIndex([t]), { '2026-09-20': true });
});

test('openDueDayIndex: a COMPLETED task due that day does not set a key -- no marker for it', () => {
  const m = load();
  const t = task({ due: '2026-09-20', status: 'COMPLETED', completed: true });
  assert.deepEqual(m.openDueDayIndex([t]), {});
});

test('openDueDayIndex: a task with only the derived `completed` flag (no STATUS) is still excluded', () => {
  const m = load();
  const t = task({ due: '2026-09-20', status: 'NEEDS-ACTION', completed: true });
  assert.deepEqual(m.openDueDayIndex([t]), {});
});

test('openDueDayIndex: two open tasks due the same day collapse to one key', () => {
  const m = load();
  const a = task({ due: '2026-09-20' });
  const b = task({ due: '2026-09-20' });
  assert.deepEqual(m.openDueDayIndex([a, b]), { '2026-09-20': true });
});

test('openDueDayIndex: a task with no due date contributes nothing', () => {
  const m = load();
  const t = task({ due: null });
  assert.deepEqual(m.openDueDayIndex([t]), {});
});

test('openDueDayIndex: empty/non-array input gives an empty index', () => {
  const m = load();
  assert.deepEqual(m.openDueDayIndex([]), {});
  assert.deepEqual(m.openDueDayIndex(undefined), {});
});

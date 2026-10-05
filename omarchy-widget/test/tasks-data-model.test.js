import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';

const modelPath = fileURLToPath(new URL('../plugin/TasksDataModel.js', import.meta.url));
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

// ---- buildTasksUrl / buildTasksCompleteUrl -------------------------------------------------

test('buildTasksUrl: appends the widget tasks path', () => {
  const m = load();
  assert.equal(m.buildTasksUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/api/widget/tasks');
});

test('buildTasksUrl: strips a trailing slash on the server URL', () => {
  const m = load();
  assert.equal(m.buildTasksUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/api/widget/tasks');
});

test('buildTasksUrl: refreshLists asks the server to bypass its list-discovery cache', () => {
  const m = load();
  assert.equal(m.buildTasksUrl('http://127.0.0.1:3000/', true), 'http://127.0.0.1:3000/api/widget/tasks?refresh=lists');
  assert.equal(m.buildTasksUrl('http://127.0.0.1:3000', false), 'http://127.0.0.1:3000/api/widget/tasks');
});

test('buildTasksCompleteUrl: appends the complete path', () => {
  const m = load();
  assert.equal(
    m.buildTasksCompleteUrl('http://127.0.0.1:3000'),
    'http://127.0.0.1:3000/api/widget/tasks/complete'
  );
});

// ---- parseTasksListResponse ------------------------------------------------------------------

test('parseTasksListResponse: empty/non-string input is null', () => {
  const m = load();
  assert.equal(m.parseTasksListResponse(''), null);
  assert.equal(m.parseTasksListResponse(undefined), null);
});

test('parseTasksListResponse: invalid JSON is null', () => {
  const m = load();
  assert.equal(m.parseTasksListResponse('not json'), null);
});

test('parseTasksListResponse: missing required top-level fields is null', () => {
  const m = load();
  assert.equal(m.parseTasksListResponse(JSON.stringify({ tasks: [], lists: [] })), null); // no syncedAt/errors
  assert.equal(m.parseTasksListResponse(JSON.stringify({ tasks: [], lists: [], syncedAt: 'x' })), null); // no errors
});

test('parseTasksListResponse: a well-formed response round-trips', () => {
  const m = load();
  const t = task({ due: '2026-09-20', categories: ['admin', 'errands'] });
  const raw = JSON.stringify({
    tasks: [t],
    lists: [{ id: 'cdav_1_tasks', name: 'Tasks', accountId: 'cdav_1', url: t.listUrl }],
    syncedAt: '2026-09-15T10:00:00.000Z',
    errors: [],
  });
  const parsed = m.parseTasksListResponse(raw);
  assert.equal(parsed.tasks.length, 1);
  assert.deepEqual(parsed.tasks[0], t);
  assert.equal(parsed.lists.length, 1);
  assert.equal(parsed.lists[0].name, 'Tasks');
  assert.equal(parsed.syncedAt, '2026-09-15T10:00:00.000Z');
  assert.deepEqual(parsed.errors, []);
});

test('parseTasksListResponse: a malformed task is dropped, its siblings still parse', () => {
  const m = load();
  const good = task();
  const raw = JSON.stringify({
    tasks: [good, { title: 'no id' }, null, 'not an object'],
    lists: [],
    syncedAt: '2026-09-15T10:00:00.000Z',
    errors: [],
  });
  const parsed = m.parseTasksListResponse(raw);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].id, good.id);
});

test('parseTasksListResponse: a malformed list is dropped, its siblings still parse', () => {
  const m = load();
  const raw = JSON.stringify({
    tasks: [],
    lists: [{ id: 'ok-list', name: 'Ok' }, { name: 'no id' }, null],
    syncedAt: '2026-09-15T10:00:00.000Z',
    errors: [],
  });
  const parsed = m.parseTasksListResponse(raw);
  assert.equal(parsed.lists.length, 1);
  assert.equal(parsed.lists[0].id, 'ok-list');
});

test('parseTasksListResponse: errors carry listId and message through', () => {
  const m = load();
  const raw = JSON.stringify({
    tasks: [],
    lists: [],
    syncedAt: '2026-09-15T10:00:00.000Z',
    errors: [{ listId: 'cdav_2_XYZ', message: 'boom' }],
  });
  const parsed = m.parseTasksListResponse(raw);
  assert.deepEqual(parsed.errors, [{ listId: 'cdav_2_XYZ', message: 'boom' }]);
});

test('parseTasksListResponse: a task missing optional fields degrades to Task defaults', () => {
  const m = load();
  const raw = JSON.stringify({
    tasks: [{ id: 'bare-1' }],
    lists: [],
    syncedAt: '2026-09-15T10:00:00.000Z',
    errors: [],
  });
  const parsed = m.parseTasksListResponse(raw);
  assert.deepEqual(parsed.tasks[0], {
    id: 'bare-1',
    uid: '',
    title: '(no title)',
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
    listId: '',
    listName: '',
    listUrl: '',
    accountId: '',
    etag: null,
  });
});

test('parseTasksListResponse: completed derives from status COMPLETED even if the flag is absent', () => {
  const m = load();
  const raw = JSON.stringify({
    tasks: [{ id: 't1', status: 'COMPLETED' }],
    lists: [],
    syncedAt: '2026-09-15T10:00:00.000Z',
    errors: [],
  });
  const parsed = m.parseTasksListResponse(raw);
  assert.equal(parsed.tasks[0].completed, true);
});

// ---- parseTaskResponse -----------------------------------------------------------------------

test('parseTaskResponse: empty/invalid input is null', () => {
  const m = load();
  assert.equal(m.parseTaskResponse(''), null);
  assert.equal(m.parseTaskResponse('not json'), null);
  assert.equal(m.parseTaskResponse(JSON.stringify({ notTask: {} })), null);
});

test('parseTaskResponse: a well-formed { task } response round-trips', () => {
  const m = load();
  const t = task();
  const parsed = m.parseTaskResponse(JSON.stringify({ task: t }));
  assert.deepEqual(parsed, t);
});

test('parseTaskResponse: a task with no id is null', () => {
  const m = load();
  assert.equal(m.parseTaskResponse(JSON.stringify({ task: { title: 'x' } })), null);
});

// ---- isTaskCompleted --------------------------------------------------------------------------

test('isTaskCompleted: true when completed flag is true', () => {
  const m = load();
  assert.equal(m.isTaskCompleted(task({ completed: true })), true);
});

test('isTaskCompleted: true when status is COMPLETED even if the flag lags (stale cache)', () => {
  const m = load();
  assert.equal(m.isTaskCompleted(task({ completed: false, status: 'COMPLETED' })), true);
});

test('isTaskCompleted: false for NEEDS-ACTION/IN-PROCESS', () => {
  const m = load();
  assert.equal(m.isTaskCompleted(task({ status: 'NEEDS-ACTION' })), false);
  assert.equal(m.isTaskCompleted(task({ status: 'IN-PROCESS' })), false);
});

test('isTaskCompleted: null/undefined task is false', () => {
  const m = load();
  assert.equal(m.isTaskCompleted(null), false);
  assert.equal(m.isTaskCompleted(undefined), false);
});

// ---- applyOptimisticComplete ------------------------------------------------------------------

test('applyOptimisticComplete: marks the matching task completed with percent/status/completedAt', () => {
  const m = load();
  const t = task({ id: 'x1' });
  const out = m.applyOptimisticComplete([t], 'x1', true, '2026-09-15T10:00:00.000Z');
  assert.equal(out[0].completed, true);
  assert.equal(out[0].status, 'COMPLETED');
  assert.equal(out[0].percent, 100);
  assert.equal(out[0].completedAt, '2026-09-15T10:00:00.000Z');
});

test('applyOptimisticComplete: un-completing clears completedAt and zeroes percent', () => {
  const m = load();
  const t = task({ id: 'x1', completed: true, status: 'COMPLETED', percent: 100, completedAt: '2026-01-01T00:00:00.000Z' });
  const out = m.applyOptimisticComplete([t], 'x1', false, '2026-09-15T10:00:00.000Z');
  assert.equal(out[0].completed, false);
  assert.equal(out[0].status, 'NEEDS-ACTION');
  assert.equal(out[0].percent, 0);
  assert.equal(out[0].completedAt, null);
});

test('applyOptimisticComplete: leaves non-matching tasks untouched and does not mutate the input', () => {
  const m = load();
  const a = task({ id: 'a' });
  const b = task({ id: 'b' });
  const out = m.applyOptimisticComplete([a, b], 'a', true, '2026-09-15T10:00:00.000Z');
  assert.equal(out[1], b); // untouched sibling is the same reference
  assert.equal(a.completed, false); // original object untouched
});

test('applyOptimisticComplete: a non-string nowIso leaves completedAt null instead of throwing', () => {
  const m = load();
  const t = task({ id: 'x1' });
  const out = m.applyOptimisticComplete([t], 'x1', true, undefined);
  assert.equal(out[0].completedAt, null);
});

// ---- insertOptimisticTask / removeTaskById / replaceTaskById -----------------------------------

test('insertOptimisticTask: unshifts onto the front', () => {
  const m = load();
  const existing = task({ id: 'e1' });
  const fresh = task({ id: 'temp-1' });
  const out = m.insertOptimisticTask([existing], fresh);
  assert.deepEqual(out.map((t) => t.id), ['temp-1', 'e1']);
});

test('insertOptimisticTask: tolerates a non-array input', () => {
  const m = load();
  const fresh = task({ id: 'temp-1' });
  assert.deepEqual(m.insertOptimisticTask(null, fresh).map((t) => t.id), ['temp-1']);
});

test('removeTaskById: drops only the matching id', () => {
  const m = load();
  const a = task({ id: 'a' });
  const b = task({ id: 'b' });
  const out = m.removeTaskById([a, b], 'a');
  assert.deepEqual(out.map((t) => t.id), ['b']);
});

test('replaceTaskById: swaps the matching task in place, order preserved', () => {
  const m = load();
  const a = task({ id: 'a' });
  const b = task({ id: 'temp-1' });
  const c = task({ id: 'c' });
  const real = task({ id: 'real-uid' });
  const out = m.replaceTaskById([a, b, c], 'temp-1', real);
  assert.deepEqual(out.map((t) => t.id), ['a', 'real-uid', 'c']);
});

test('replaceTaskById: prepends instead of dropping when nothing matched', () => {
  const m = load();
  const a = task({ id: 'a' });
  const real = task({ id: 'real-uid' });
  const out = m.replaceTaskById([a], 'temp-1-not-present', real);
  assert.deepEqual(out.map((t) => t.id), ['real-uid', 'a']);
});

// ---- previewQuickAdd (cosmetic optimistic-row preview) -----------------------------------------

test('previewQuickAdd: strips @category tokens into categories, repeatable', () => {
  const m = load();
  const out = m.previewQuickAdd('call the bank @admin @finance');
  assert.equal(out.title, 'call the bank');
  assert.deepEqual(out.categories, ['admin', 'finance']);
});

test('previewQuickAdd: strips !N into priority, last one wins', () => {
  const m = load();
  const out = m.previewQuickAdd('call the bank !3 !1');
  assert.equal(out.title, 'call the bank');
  assert.equal(out.priority, 1);
});

test('previewQuickAdd: does not touch due: tokens (not reimplemented client-side)', () => {
  const m = load();
  const out = m.previewQuickAdd('call the bank due:friday');
  assert.equal(out.title, 'call the bank due:friday');
  assert.equal(out.categories.length, 0);
});

test('previewQuickAdd: a bare "!" or "@" (no token body) is left in the title untouched', () => {
  const m = load();
  const out = m.previewQuickAdd('http://x/y!2 plain@word');
  assert.equal(out.title, 'http://x/y!2 plain@word');
  assert.equal(out.categories.length, 0);
  assert.equal(out.priority, 0);
});

test('previewQuickAdd: collapses whitespace and trims', () => {
  const m = load();
  const out = m.previewQuickAdd('  call   the   bank  ');
  assert.equal(out.title, 'call the bank');
});

test('previewQuickAdd: empty text yields an empty title', () => {
  const m = load();
  const out = m.previewQuickAdd('');
  assert.equal(out.title, '');
  assert.deepEqual(out.categories, []);
  assert.equal(out.priority, 0);
});

test('previewQuickAdd: strips a +list token out of the title and reports it', () => {
  const m = load();
  const out = m.previewQuickAdd('Prune the apple tree +garden due:friday');
  assert.equal(out.title, 'Prune the apple tree due:friday');
  assert.equal(out.listToken, 'garden');
});

test('previewQuickAdd: +token with hyphens or diacritics is a list token; +digits is not', () => {
  const m = load();
  assert.equal(m.previewQuickAdd('x +home-repairs').listToken, 'home-repairs');
  assert.equal(m.previewQuickAdd('x +čitanje').listToken, 'čitanje');
  const phone = m.previewQuickAdd('Call dentist +15555550100');
  assert.equal(phone.listToken, '');
  assert.equal(phone.title, 'Call dentist +15555550100');
});

test('previewQuickAdd: no +token gives an empty listToken', () => {
  const m = load();
  assert.equal(m.previewQuickAdd('Call dentist').listToken, '');
});

// ---- parseErrorResponse -------------------------------------------------------------------------

test('parseErrorResponse: pulls the server error message out of a JSON body', () => {
  const m = load();
  assert.equal(
    m.parseErrorResponse('{"error":"No task list matches +work. Lists: Errands, Garden, Reading"}'),
    'No task list matches +work. Lists: Errands, Garden, Reading'
  );
});

test('parseErrorResponse: anything else is an empty string', () => {
  const m = load();
  assert.equal(m.parseErrorResponse(''), '');
  assert.equal(m.parseErrorResponse('not json'), '');
  assert.equal(m.parseErrorResponse('{"task":{"id":"x"}}'), '');
  assert.equal(m.parseErrorResponse('{"error":42}'), '');
  assert.equal(m.parseErrorResponse(null), '');
});

// ---- composeTasksStatus -------------------------------------------------------------------------

test('composeTasksStatus: quiet when the fetch is fresh and nothing failed', () => {
  const m = load();
  assert.equal(m.composeTasksStatus({ lastFetchOk: true, serverReachable: true, errors: [] }), '');
});

test('composeTasksStatus: addFailed prefixes "task not added"', () => {
  const m = load();
  const text = m.composeTasksStatus({ lastFetchOk: true, serverReachable: true, errors: [], addFailed: true });
  assert.equal(text, 'task not added');
});

test('composeTasksStatus: addError is appended to "task not added"', () => {
  const m = load();
  const text = m.composeTasksStatus({
    lastFetchOk: true, serverReachable: true, errors: [], addFailed: true,
    addError: '+g matches more than one task list: Garden, Groceries',
  });
  assert.equal(text, 'task not added: +g matches more than one task list: Garden, Groceries');
});

test('composeTasksStatus: toggleFailed prefixes "task not saved"', () => {
  const m = load();
  const text = m.composeTasksStatus({ lastFetchOk: true, serverReachable: true, errors: [], toggleFailed: true });
  assert.equal(text, 'task not saved');
});

test('composeTasksStatus: unreachable server reports "tasks unavailable" plus the synced label', () => {
  const m = load();
  const text = m.composeTasksStatus({
    lastFetchOk: false,
    serverReachable: false,
    errors: [],
    syncedLabel: 'synced 5 min ago',
  });
  assert.equal(text, 'tasks unavailable · synced 5 min ago');
});

test('composeTasksStatus: a per-list error names the list by id when the list is unknown', () => {
  const m = load();
  const text = m.composeTasksStatus({
    lastFetchOk: true,
    serverReachable: true,
    errors: [{ listId: 'cdav_2_XYZ', message: 'boom' }],
    lists: [],
  });
  assert.equal(text, 'cdav_2_XYZ unavailable');
});

test('composeTasksStatus: a per-list error names the list by its display name when known', () => {
  const m = load();
  const text = m.composeTasksStatus({
    lastFetchOk: true,
    serverReachable: true,
    errors: [{ listId: 'cdav_2_XYZ', message: 'boom' }],
    lists: [{ id: 'cdav_2_XYZ', name: 'Work Tasks' }],
  });
  assert.equal(text, 'Work Tasks unavailable');
});

test('composeTasksStatus: combines a failed local edit with an unreachable server', () => {
  const m = load();
  const text = m.composeTasksStatus({
    lastFetchOk: false,
    serverReachable: false,
    errors: [],
    toggleFailed: true,
    syncedLabel: 'synced 1 h ago',
  });
  assert.equal(text, 'task not saved · tasks unavailable · synced 1 h ago');
});

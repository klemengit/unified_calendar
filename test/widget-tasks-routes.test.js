process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startWidgetTestApp } from '../test-support/http-test-app.js';
import { makeDeps } from '../test-support/widget-fixtures.js';

const NOW_ISO = '2026-09-15T10:00:00.000Z';

const ACCOUNT = {
  id: 'cdav_1',
  server: 'https://dav.example.org',
  username: 'testuser',
  password: 'testpass',
  displayName: 'Test Account',
};

const LIST = {
  id: 'cdav_1_tasks',
  url: 'https://dav.example.org/caldav/tasks/',
  name: 'Tasks',
  color: null,
};

function makeTask(overrides = {}) {
  return {
    id: 'cdavtodo-uid-1',
    uid: 'uid-1',
    title: 'Renew the parking permit',
    notes: 'Connect bank feed',
    status: 'NEEDS-ACTION',
    completed: false,
    completedAt: null,
    due: null,
    dueHasTime: false,
    start: null,
    priority: 0,
    percent: 0,
    categories: ['admin'],
    listId: LIST.id,
    listName: LIST.name,
    listUrl: LIST.url,
    accountId: ACCOUNT.id,
    etag: '1111673-3-1784650673809',
    ...overrides,
  };
}

// Builds a deps object with one CalDAV account and, by default, one task list holding no tasks —
// override discoverTaskLists/fetchCalDavTasks/createCalDavTask/updateCalDavTask per test.
function makeTasksDeps(overrides = {}) {
  const deps = makeDeps({
    state: { caldavAccounts: [ACCOUNT] },
    discoverTaskLists: async () => [LIST],
    fetchCalDavTasks: async () => [],
    createCalDavTask: async () => { throw new Error('createCalDavTask not stubbed for this test'); },
    updateCalDavTask: async () => { throw new Error('updateCalDavTask not stubbed for this test'); },
    ...overrides,
  });
  deps.now = () => new Date(NOW_ISO);
  return deps;
}

async function getJson(baseUrl, pathAndQuery) {
  const res = await fetch(`${baseUrl}${pathAndQuery}`);
  const body = await res.json();
  return { res, body };
}

async function postJson(baseUrl, pathAndQuery, payload) {
  const res = await fetch(`${baseUrl}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { res, body };
}

// ── GET /api/widget/tasks: response shape ──────────────────────

test('GET /api/widget/tasks: full response shape, field by field', async () => {
  const task = makeTask();
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks, [task]);
    assert.deepEqual(body.lists, [{ id: LIST.id, name: LIST.name, accountId: ACCOUNT.id, url: LIST.url }]);
    assert.equal(body.syncedAt, NOW_ISO);
    assert.deepEqual(body.errors, []);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: no CalDAV account configured -> empty response, 200', async () => {
  const deps = makeTasksDeps({ state: { caldavAccounts: [] } });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body, { tasks: [], lists: [], syncedAt: NOW_ISO, errors: [] });
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: a failing list lands in errors while a healthy list still returns its tasks', async () => {
  const listOk = { id: 'cdav_1_ok', url: 'https://dav.example.org/ok/', name: 'OK', color: null };
  const listBad = { id: 'cdav_1_bad', url: 'https://dav.example.org/bad/', name: 'Bad', color: null };
  const okTask = makeTask({ id: 'cdavtodo-ok', uid: 'ok', listId: listOk.id, listUrl: listOk.url });

  const deps = makeTasksDeps({
    discoverTaskLists: async () => [listOk, listBad],
    fetchCalDavTasks: async (account, list) => {
      if (list.id === listBad.id) throw new Error('CalDAV REPORT returned 500');
      return [okTask];
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks, [okTask]);
    assert.equal(body.lists.length, 2);
    assert.deepEqual(body.errors, [{ listId: listBad.id, message: 'CalDAV REPORT returned 500' }]);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: a failing account discovery lands in errors, keyed by accountId', async () => {
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { throw new Error('CalDAV discovery failed: bad credentials'); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks, []);
    assert.deepEqual(body.lists, []);
    assert.deepEqual(body.errors, [{ listId: ACCOUNT.id, message: 'CalDAV discovery failed: bad credentials' }]);
  } finally {
    await app.close();
  }
});

// ── GET /api/widget/tasks: discovery cache ──────────────────────

test('GET /api/widget/tasks: discovery is cached within the TTL and re-runs once the TTL has elapsed', async () => {
  let discoverCalls = 0;
  let currentNow = new Date(NOW_ISO);
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { discoverCalls += 1; return [LIST]; },
  });
  deps.now = () => currentNow;

  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(discoverCalls, 1, 'first request discovers');

    currentNow = new Date(currentNow.getTime() + 59 * 60 * 1000); // +59min, still inside the 1h TTL
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(discoverCalls, 1, 'second request within the TTL reuses the cached discovery');

    currentNow = new Date(currentNow.getTime() + 2 * 60 * 1000); // total +61min, past the TTL
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(discoverCalls, 2, 'a request past the TTL re-discovers');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: a failed discovery is never cached as success — the next request retries it', async () => {
  let discoverCalls = 0;
  const deps = makeTasksDeps({
    discoverTaskLists: async () => {
      discoverCalls += 1;
      if (discoverCalls === 1) throw new Error('temporary DNS failure');
      return [LIST];
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const first = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.deepEqual(first.body.errors, [{ listId: ACCOUNT.id, message: 'temporary DNS failure' }]);

    const second = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.deepEqual(second.body.lists, [{ id: LIST.id, name: LIST.name, accountId: ACCOUNT.id, url: LIST.url }]);
    assert.equal(discoverCalls, 2, 'the failed first discovery was not cached, so the second request tried again');
  } finally {
    await app.close();
  }
});

// ── GET /api/widget/tasks: auth ──────────────────────

test('GET /api/widget/tasks: 401 when isAuthorized returns false', async () => {
  const deps = makeTasksDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

// ── POST /api/widget/tasks: add ──────────────────────

test('POST /api/widget/tasks: happy path, defaults to the first discovered list, 201 with the created Task', async () => {
  let captured = null;
  const created = makeTask({ id: 'cdavtodo-new', uid: 'new', title: 'buy milk' });
  const deps = makeTasksDeps({
    createCalDavTask: async (account, list, fields) => {
      captured = { account, list, fields };
      return created;
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk' });
    assert.equal(res.status, 201);
    assert.deepEqual(body, { task: created });
    assert.equal(captured.account.id, ACCOUNT.id);
    assert.equal(captured.list.id, LIST.id);
    assert.equal(captured.fields.title, 'buy milk');
    assert.equal(captured.fields.status, 'NEEDS-ACTION');
    assert.equal(captured.fields.percent, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: quick-add grammar (category/priority/due) is parsed into the created fields', async () => {
  let captured = null;
  const deps = makeTasksDeps({
    createCalDavTask: async (account, list, fields) => {
      captured = fields;
      return makeTask();
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'call the bank @admin due:tomorrow !1' });
    assert.equal(res.status, 201);
    assert.equal(captured.title, 'call the bank');
    assert.deepEqual(captured.categories, ['admin']);
    assert.equal(captured.priority, 1);
    assert.equal(captured.due, '2026-09-16');
    assert.equal(captured.dueHasTime, false);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: an explicit listId routes the create call to that list', async () => {
  const listB = { id: 'cdav_1_B', url: 'https://dav.example.org/b/', name: 'B', color: null };
  let captured = null;
  const deps = makeTasksDeps({
    discoverTaskLists: async () => [LIST, listB],
    createCalDavTask: async (account, list, fields) => { captured = { list, fields }; return makeTask(); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'a task', listId: listB.id });
    assert.equal(res.status, 201);
    assert.equal(captured.list.id, listB.id);
  } finally {
    await app.close();
  }
});

for (const [label, text] of [
  ['empty', ''],
  ['whitespace-only', '   '],
  ['over-length', 'x'.repeat(501)],
]) {
  test(`POST /api/widget/tasks: ${label} text gives 400`, async () => {
    const deps = makeTasksDeps();
    const app = await startWidgetTestApp(deps);
    try {
      const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text });
      assert.equal(res.status, 400);
      assert.equal(typeof body.error, 'string');
    } finally {
      await app.close();
    }
  });
}

test('POST /api/widget/tasks: an unknown listId gives 404 (this route\'s chosen status for "no such list")', async () => {
  const deps = makeTasksDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk', listId: 'nope' });
    assert.equal(res.status, 404);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: an unknown listId forces one rediscovery before giving up', async () => {
  let discoverCalls = 0;
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { discoverCalls += 1; return [LIST]; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk', listId: 'nope' });
    assert.equal(res.status, 404);
    assert.equal(discoverCalls, 2, 'the cached list and one forced refresh were both tried');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: no task list configured yet gives 400', async () => {
  const deps = makeTasksDeps({ discoverTaskLists: async () => [] });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk' });
    assert.equal(res.status, 400);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: 401 when isAuthorized returns false', async () => {
  const deps = makeTasksDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

// ── POST /api/widget/tasks/complete ──────────────────────

test('POST /api/widget/tasks/complete: marking a task complete', async () => {
  const task = makeTask({ status: 'NEEDS-ACTION', completed: false });
  const updated = makeTask({ status: 'COMPLETED', completed: true, completedAt: NOW_ISO, percent: 100 });
  let capturedFields = null;
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async (account, list, taskArg, fields) => { capturedFields = fields; return updated; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: true });
    assert.equal(res.status, 200);
    assert.deepEqual(body, { task: updated });
    assert.equal(capturedFields.status, 'COMPLETED');
    assert.equal(capturedFields.percent, 100);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: marking a task incomplete', async () => {
  const task = makeTask({ status: 'COMPLETED', completed: true, completedAt: NOW_ISO, percent: 100 });
  const updated = makeTask({ status: 'NEEDS-ACTION', completed: false, completedAt: null, percent: 0 });
  let capturedFields = null;
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async (account, list, taskArg, fields) => { capturedFields = fields; return updated; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: false });
    assert.equal(res.status, 200);
    assert.deepEqual(body, { task: updated });
    assert.equal(capturedFields.status, 'NEEDS-ACTION');
    assert.equal(capturedFields.percent, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: a 412 from updateCalDavTask ("changed on the server") maps to HTTP 409', async () => {
  const task = makeTask();
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async () => {
      throw new Error('CalDAV PUT failed: task was changed on the server since it was last fetched (412 Precondition Failed)');
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: true });
    assert.equal(res.status, 409);
    assert.match(body.error, /changed on the server/);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: an unknown task id gives 404', async () => {
  const deps = makeTasksDeps({ fetchCalDavTasks: async () => [] });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: 'cdavtodo-ghost', completed: true });
    assert.equal(res.status, 404);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: a non-CalDAV update failure maps to 502', async () => {
  const task = makeTask();
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async () => { throw new Error('CalDAV PUT failed: 500'); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: true });
    assert.equal(res.status, 502);
  } finally {
    await app.close();
  }
});

for (const [label, body] of [
  ['missing id', { completed: true }],
  ['non-string id', { id: 42, completed: true }],
  ['missing completed', { id: 'cdavtodo-uid-1' }],
  ['non-boolean completed', { id: 'cdavtodo-uid-1', completed: 'yes' }],
]) {
  test(`POST /api/widget/tasks/complete: ${label} gives 400`, async () => {
    const deps = makeTasksDeps();
    const app = await startWidgetTestApp(deps);
    try {
      const { res, body: respBody } = await postJson(app.baseUrl, '/api/widget/tasks/complete', body);
      assert.equal(res.status, 400);
      assert.equal(typeof respBody.error, 'string');
    } finally {
      await app.close();
    }
  });
}

test('POST /api/widget/tasks/complete: 401 when isAuthorized returns false', async () => {
  const deps = makeTasksDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: 'x', completed: true });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

// ── task lists: +token, listId precedence, discovery refresh ──────────────────────

const ERRANDS = { id: 'cdav_1_tasks', url: 'https://dav.example.org/caldav/tasks/', name: 'Errands', color: null };
const GARDEN = { id: 'cdav_1_garden', url: 'https://dav.example.org/caldav/garden/', name: 'Garden', color: null };
const READING = { id: 'cdav_1_reading', url: 'https://dav.example.org/caldav/reading/', name: 'Reading', color: null };

// Three lists, Errands first (the default); records which list each create landed in.
function makeListDeps(overrides = {}) {
  const calls = { created: [], discover: 0 };
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { calls.discover += 1; return [ERRANDS, GARDEN, READING]; },
    createCalDavTask: async (account, list, fields) => {
      calls.created.push({ list, fields });
      return makeTask({ listId: list.id, listName: list.name, title: fields.title });
    },
    ...overrides,
  });
  return { deps, calls };
}

test('POST /api/widget/tasks: +token files the task into the matching list and drops it from the title', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Prune the apple tree +garden due:friday' });
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].list.id, GARDEN.id);
    assert.equal(calls.created[0].fields.title, 'Prune the apple tree');
    assert.equal(calls.created[0].fields.due, '2026-09-18');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: +token wins over an explicit listId in the body', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist +errands', listId: GARDEN.id });
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].list.id, ERRANDS.id);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: +token wins even when the body listId does not exist', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist +read', listId: 'nope' });
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].list.id, READING.id);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: listId without a +token beats the first-list default', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist', listId: READING.id });
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].list.id, READING.id);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: no +token and no listId falls back to the first list', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Renew the parking permit' });
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].list.id, ERRANDS.id);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: an unknown +token gives 400 naming the lists, after one forced rediscovery', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist +work' });
    assert.equal(res.status, 400);
    assert.match(body.error, /\+work/);
    assert.match(body.error, /Errands, Garden, Reading/);
    assert.doesNotMatch(body.error, /cdav_|dav\.example/);
    assert.equal(calls.discover, 2, 'the cached lists and one forced refresh were both tried');
    assert.equal(calls.created.length, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: a +token for a list created after the cache was filled is found by the forced rediscovery', async () => {
  let lists = [ERRANDS, GARDEN];
  const { deps, calls } = makeListDeps({ discoverTaskLists: async () => lists });
  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/tasks'); // fills the discovery cache without Reading
    lists = [ERRANDS, GARDEN, READING];
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist +reading' });
    assert.equal(res.status, 201);
    assert.equal(calls.created[0].list.id, READING.id);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: an ambiguous +token gives 400 naming only the matching lists, without a rediscovery', async () => {
  const groceries = { id: 'cdav_1_groceries', url: 'https://dav.example.org/caldav/groceries/', name: 'Groceries', color: null };
  const { deps, calls } = makeListDeps({
    discoverTaskLists: async () => { calls.discover += 1; return [ERRANDS, GARDEN, groceries]; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist +g' });
    assert.equal(res.status, 400);
    assert.match(body.error, /Garden, Groceries/);
    assert.doesNotMatch(body.error, /Errands/);
    assert.equal(calls.discover, 1);
    assert.equal(calls.created.length, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: two +tokens give 400', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'Call dentist +garden +errands' });
    assert.equal(res.status, 400);
    assert.equal(typeof body.error, 'string');
    assert.equal(calls.created.length, 0);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: returns every discovered list, including one with no tasks', async () => {
  const { deps } = makeListDeps({
    fetchCalDavTasks: async (account, list) => (list.id === GARDEN.id
      ? [makeTask({ title: 'Prune the apple tree', listId: GARDEN.id, listName: GARDEN.name })]
      : []),
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.deepEqual(body.lists.map((l) => l.name), ['Errands', 'Garden', 'Reading']);
    assert.equal(body.tasks.length, 1);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks?refresh=lists bypasses the discovery cache', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/tasks');
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(calls.discover, 1, 'a plain poll reuses the cache');

    const { res } = await getJson(app.baseUrl, '/api/widget/tasks?refresh=lists');
    assert.equal(res.status, 200);
    assert.equal(calls.discover, 2, 'refresh=lists re-discovers');

    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(calls.discover, 2, 'and the refreshed result is cached for the next plain poll');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: any other refresh value leaves the cache alone', async () => {
  const { deps, calls } = makeListDeps();
  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/tasks');
    await getJson(app.baseUrl, '/api/widget/tasks?refresh=1');
    assert.equal(calls.discover, 1);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: due dates count from the caller\'s `today`, not the server clock', async () => {
  let created = null;
  const deps = makeTasksDeps({
    createCalDavTask: async (account, list, fields) => {
      created = fields;
      return makeTask({ title: fields.title, due: fields.due });
    },
  });
  deps.now = () => new Date('2026-10-07T23:30:00Z'); // still the 7th on a UTC server
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'pay rent due:today', today: '2026-10-08' });
    assert.equal(res.status, 201);
    assert.equal(created.due, '2026-10-08');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: a malformed `today` is a 400', async () => {
  const app = await startWidgetTestApp(makeTasksDeps());
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'x', today: 'tomorrow' });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

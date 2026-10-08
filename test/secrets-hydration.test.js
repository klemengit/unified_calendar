import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateKeyringPasswords } from '../src/secrets.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same shape as the fake in secrets.test.js: secret-tool answers on stdout, stdin takes the secret.
function fakeExecFile({ notFound = false, code = 0, stdout = '' } = {}) {
  const calls = [];
  const fn = (file, args, options, callback) => {
    calls.push({ file, args });
    const stdin = {
      on() {},
      end() {
        queueMicrotask(() => {
          if (notFound) {
            const err = new Error('spawn secret-tool ENOENT');
            err.code = 'ENOENT';
            callback(err, '', '');
          } else if (code !== 0) {
            callback(Object.assign(new Error('Command failed'), { code }), '', '');
          } else {
            callback(null, stdout, '');
          }
        });
      },
    };
    return { stdin };
  };
  fn.calls = calls;
  return fn;
}

function fakeStore(accounts) {
  return {
    accounts,
    getCaldavAccounts: () => accounts,
    hydrateCaldavPassword(id, password) {
      const account = accounts.find((a) => a.id === id);
      if (account) account.password = password;
    },
  };
}

test('hydrateKeyringPasswords: fills a blanked password from the keyring', async () => {
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: '' }]);
  const execFileFn = fakeExecFile({ stdout: 'from-keyring' });
  const result = await hydrateKeyringPasswords(store, { execFileFn });
  assert.equal(result.hydrated, 1);
  assert.equal(store.accounts[0].password, 'from-keyring');
});

test('hydrateKeyringPasswords: leaves an un-migrated plaintext password alone', async () => {
  // No keyring on this machine: the plaintext value is the only working credential.
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: 'still-plaintext' }]);
  const execFileFn = fakeExecFile({ stdout: 'should-not-be-used' });
  const result = await hydrateKeyringPasswords(store, { execFileFn });
  assert.equal(result.hydrated, 0);
  assert.equal(execFileFn.calls.length, 0, 'must not even consult the keyring');
  assert.equal(store.accounts[0].password, 'still-plaintext');
});

test('hydrateKeyringPasswords: an unreadable keyring is reported, not thrown', async () => {
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: '' }]);
  const result = await hydrateKeyringPasswords(store, { execFileFn: fakeExecFile({ notFound: true }) });
  assert.equal(result.hydrated, 0);
  assert.equal(result.missing, 1);
  assert.equal(store.accounts[0].password, '');
});

test('hydrateKeyringPasswords: handles several accounts independently', async () => {
  const store = fakeStore([
    { id: 'cdav_1', username: 'a@x.org', password: '' },
    { id: 'cdav_2', username: 'b@x.org', password: 'plain' },
  ]);
  const result = await hydrateKeyringPasswords(store, { execFileFn: fakeExecFile({ stdout: 'kr' }) });
  assert.equal(result.hydrated, 1);
  assert.equal(store.accounts[0].password, 'kr');
  assert.equal(store.accounts[1].password, 'plain');
});

test('hydrateKeyringPasswords: no accounts is a clean no-op', async () => {
  const result = await hydrateKeyringPasswords(fakeStore([]), { execFileFn: fakeExecFile() });
  assert.deepEqual(result, { hydrated: 0, missing: 0 });
});

// Source-level wiring checks, in the style of test/server-wiring.test.js — server.js is never
// imported by the suite (it binds a port at module scope), so its startup order is asserted as text.
test('server.js: migrates CalDAV passwords before hydrating them', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  const migrateIdx = src.indexOf('migratePlaintextPasswords({');
  const hydrateIdx = src.indexOf('hydrateKeyringPasswords({');
  assert.notEqual(migrateIdx, -1, 'server.js never calls migratePlaintextPasswords');
  assert.notEqual(hydrateIdx, -1, 'server.js never calls hydrateKeyringPasswords');
  assert.ok(migrateIdx < hydrateIdx, 'hydration must run after migration, or it reads a stale keyring');
});

test('server.js: both password steps run after loadSettings()', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  const loadIdx = src.indexOf('loadSettings();');
  assert.notEqual(loadIdx, -1);
  assert.ok(loadIdx < src.indexOf('migratePlaintextPasswords({'), 'nothing to migrate before settings load');
});

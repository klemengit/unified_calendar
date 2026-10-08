process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPassword,
  setPassword,
  deletePassword,
  secretToolAvailable,
  resolveCaldavPassword,
  migratePlaintextPasswords,
} from '../src/secrets.js';

// Fakes node:child_process's execFile signature (file, args, options, callback) -> ChildProcess,
// closely enough for runSecretTool: a callback invoked with (error, stdout, stderr), and a
// `.stdin` with `.on('error', ...)` / `.end(data)`. Captures every call for assertions so tests
// never touch the real secret-tool binary or the real keyring.
function fakeExecFile({ notFound = false, code = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const fn = (file, args, options, callback) => {
    const call = { file, args, options, input: undefined };
    calls.push(call);
    const stdin = {
      on() {},
      end(data) {
        call.input = data;
        queueMicrotask(() => {
          if (notFound) {
            const err = new Error('spawn secret-tool ENOENT');
            err.code = 'ENOENT';
            callback(err, '', '');
          } else if (code !== 0) {
            const err = new Error('Command failed');
            err.code = code;
            callback(err, stdout, stderr);
          } else {
            callback(null, stdout, stderr);
          }
        });
      },
    };
    return { stdin };
  };
  fn.calls = calls;
  return fn;
}

// Captures console.error lines during `fn`, restoring the real one afterwards even if `fn` throws.
async function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ── getPassword ──

test('getPassword returns the stored secret on success', async () => {
  const execFileFn = fakeExecFile({ code: 0, stdout: 'hunter2' });
  const pw = await getPassword('cdav_1', 'me@example.org', { execFileFn });
  assert.equal(pw, 'hunter2');
  assert.equal(execFileFn.calls.length, 1);
  assert.deepEqual(execFileFn.calls[0].args, [
    'lookup', 'service', 'unified_calendar', 'account', 'cdav_1', 'username', 'me@example.org',
  ]);
  assert.equal(execFileFn.calls[0].file, 'secret-tool');
});

test('getPassword returns null when there is no stored entry (non-zero exit, no warning)', async () => {
  const execFileFn = fakeExecFile({ code: 1, stdout: '', stderr: 'no secret found' });
  const lines = await captureStderr(async () => {
    const pw = await getPassword('cdav_1', 'me@example.org', { execFileFn });
    assert.equal(pw, null);
  });
  assert.deepEqual(lines, []); // "no entry" isn't a keyring-unavailable condition
});

test('getPassword returns null and warns (once, generic message) when secret-tool is missing', async () => {
  const execFileFn = fakeExecFile({ notFound: true });
  const lines = await captureStderr(async () => {
    const pw = await getPassword('cdav_1', 'me@example.org', { execFileFn });
    assert.equal(pw, null);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /keyring unavailable/);
  assert.doesNotMatch(lines[0], /hunter2/);
});

// ── setPassword ──

test('setPassword sends the password on stdin, never as an argv element', async () => {
  const execFileFn = fakeExecFile({ code: 0 });
  await setPassword('cdav_1', 'me@example.org', 's3cr3t-p@ss', { execFileFn });
  assert.equal(execFileFn.calls.length, 1);
  const call = execFileFn.calls[0];
  assert.equal(call.input, 's3cr3t-p@ss');
  for (const arg of call.args) {
    assert.doesNotMatch(String(arg), /s3cr3t-p@ss/);
  }
  assert.deepEqual(call.args, [
    'store', '--label=unified_calendar CalDAV (me@example.org)',
    'service', 'unified_calendar', 'account', 'cdav_1', 'username', 'me@example.org',
  ]);
});

test('setPassword never uses a shell (invoked via execFile-style file+args, not a command string)', async () => {
  const execFileFn = fakeExecFile({ code: 0 });
  await setPassword('cdav_1; rm -rf ~', 'me@example.org', 'pw', { execFileFn });
  const call = execFileFn.calls[0];
  assert.equal(call.file, 'secret-tool');
  assert.ok(Array.isArray(call.args));
  // The malicious accountId is just one argv element, never concatenated into anything shell-parsed.
  assert.ok(call.args.includes('cdav_1; rm -rf ~'));
});

test('setPassword warns on a non-zero exit (locked keyring etc.) without leaking the password', async () => {
  const execFileFn = fakeExecFile({ code: 1, stderr: 'Cannot create an item in a locked collection' });
  const lines = await captureStderr(async () => {
    await setPassword('cdav_1', 'me@example.org', 'topsecret', { execFileFn });
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /topsecret/);
});

test('setPassword warns when secret-tool is missing', async () => {
  const execFileFn = fakeExecFile({ notFound: true });
  const lines = await captureStderr(async () => {
    await setPassword('cdav_1', 'me@example.org', 'topsecret', { execFileFn });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /keyring unavailable/);
});

// ── deletePassword ──

test('deletePassword issues a clear with the right attributes', async () => {
  const execFileFn = fakeExecFile({ code: 0 });
  await deletePassword('cdav_1', 'me@example.org', { execFileFn });
  assert.deepEqual(execFileFn.calls[0].args, [
    'clear', 'service', 'unified_calendar', 'account', 'cdav_1', 'username', 'me@example.org',
  ]);
});

test('deletePassword does not warn on a plain non-zero exit (nothing to clear)', async () => {
  const execFileFn = fakeExecFile({ code: 1 });
  const lines = await captureStderr(async () => {
    await deletePassword('cdav_1', 'me@example.org', { execFileFn });
  });
  assert.deepEqual(lines, []);
});

// ── secretToolAvailable ──

test('secretToolAvailable is true when an executable secret-tool exists on PATH', () => {
  const accessSync = (file) => {
    if (file === '/usr/bin/secret-tool') return; // exists, no throw
    const err = new Error('ENOENT');
    throw err;
  };
  const available = secretToolAvailable({ env: { PATH: '/usr/local/bin:/usr/bin' }, accessSync });
  assert.equal(available, true);
});

test('secretToolAvailable is false when no PATH entry has it', () => {
  const accessSync = () => {
    throw new Error('ENOENT');
  };
  const available = secretToolAvailable({ env: { PATH: '/usr/local/bin:/usr/bin' }, accessSync });
  assert.equal(available, false);
});

test('secretToolAvailable is false with an empty/missing PATH', () => {
  const accessSync = () => {
    throw new Error('ENOENT');
  };
  assert.equal(secretToolAvailable({ env: {}, accessSync }), false);
});

// ── resolveCaldavPassword ──

test('resolveCaldavPassword prefers the keyring copy', async () => {
  const execFileFn = fakeExecFile({ code: 0, stdout: 'from-keyring' });
  const pw = await resolveCaldavPassword(
    { id: 'cdav_1', username: 'me@example.org', password: 'from-settings-json' },
    { execFileFn }
  );
  assert.equal(pw, 'from-keyring');
});

test('resolveCaldavPassword falls back to the plaintext field when the keyring has nothing', async () => {
  const execFileFn = fakeExecFile({ code: 1 }); // no entry
  const pw = await resolveCaldavPassword(
    { id: 'cdav_1', username: 'me@example.org', password: 'from-settings-json' },
    { execFileFn }
  );
  assert.equal(pw, 'from-settings-json');
});

test('resolveCaldavPassword falls back to plaintext when secret-tool is missing entirely', async () => {
  const execFileFn = fakeExecFile({ notFound: true });
  await captureStderr(async () => {
    const pw = await resolveCaldavPassword(
      { id: 'cdav_1', username: 'me@example.org', password: 'from-settings-json' },
      { execFileFn }
    );
    assert.equal(pw, 'from-settings-json');
  });
});

test('resolveCaldavPassword returns null for a null account', async () => {
  assert.equal(await resolveCaldavPassword(null), null);
});

// ── migratePlaintextPasswords ──

// A minimal fake of the store surface migratePlaintextPasswords needs: getCaldavAccounts() and
// clearCaldavPassword(id). Mutates the same account objects a real store would.
function fakeStore(accounts) {
  const list = accounts;
  return {
    accounts: list,
    getCaldavAccounts: () => list,
    clearCaldavPassword(id) {
      const account = list.find((a) => a.id === id);
      if (account) account.password = '';
    },
  };
}

test('migratePlaintextPasswords: successful migration blanks the plaintext field', async () => {
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: 'mysecretpw' }]);
  const execFileFn = fakeExecFile({ code: 0, stdout: 'mysecretpw' }); // store succeeds, read-back matches
  const lines = await captureStderr(async () => {
    const result = await migratePlaintextPasswords(store, { execFileFn });
    assert.deepEqual(result, { migrated: 1, skipped: 0, failed: 0 });
  });
  assert.equal(store.accounts[0].password, '');
  // The one-line summary must never contain the password itself.
  assert.ok(lines.some((l) => /password migration/.test(l)));
  for (const l of lines) assert.doesNotMatch(l, /mysecretpw/);
});

test('migratePlaintextPasswords: a bad read-back leaves the plaintext password intact (the hard requirement)', async () => {
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: 'mysecretpw' }]);
  // Simulates a store that reports success but a keyring that actually holds nothing / something
  // else — code 0 on both `store` and `lookup`, but `lookup`'s stdout comes back empty.
  let call = 0;
  const execFileFn = (file, args, options, callback) => {
    call++;
    const stdin = {
      on() {},
      end() {
        queueMicrotask(() => callback(null, '', '')); // both calls "succeed" with empty stdout
      },
    };
    return { stdin };
  };
  const result = await migratePlaintextPasswords(store, { execFileFn });
  assert.deepEqual(result, { migrated: 0, skipped: 0, failed: 1 });
  assert.equal(store.accounts[0].password, 'mysecretpw'); // untouched — this is the one thing that must never break
  assert.equal(call, 2); // store, then lookup — both were attempted
});

test('migratePlaintextPasswords: keyring entirely unavailable leaves every plaintext password intact', async () => {
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: 'mysecretpw' }]);
  const execFileFn = fakeExecFile({ notFound: true });
  await captureStderr(async () => {
    const result = await migratePlaintextPasswords(store, { execFileFn });
    assert.deepEqual(result, { migrated: 0, skipped: 0, failed: 1 });
  });
  assert.equal(store.accounts[0].password, 'mysecretpw');
});

test('migratePlaintextPasswords: skips accounts with no plaintext password (empty or missing)', async () => {
  const store = fakeStore([
    { id: 'cdav_1', username: 'a@example.org', password: '' },
    { id: 'cdav_2', username: 'b@example.org' }, // no password field at all
  ]);
  const execFileFn = fakeExecFile({ code: 0, stdout: 'unused' });
  const result = await migratePlaintextPasswords(store, { execFileFn });
  assert.deepEqual(result, { migrated: 0, skipped: 2, failed: 0 });
  assert.equal(execFileFn.calls.length, 0); // never even shelled out
});

test('migratePlaintextPasswords: idempotent — a second run migrates nothing further', async () => {
  const store = fakeStore([{ id: 'cdav_1', username: 'me@example.org', password: 'mysecretpw' }]);
  const execFileFn = fakeExecFile({ code: 0, stdout: 'mysecretpw' });
  const first = await migratePlaintextPasswords(store, { execFileFn });
  assert.deepEqual(first, { migrated: 1, skipped: 0, failed: 0 });
  const second = await migratePlaintextPasswords(store, { execFileFn });
  assert.deepEqual(second, { migrated: 0, skipped: 1, failed: 0 });
});

test('migratePlaintextPasswords: mixed accounts each get the right outcome, independently', async () => {
  const store = fakeStore([
    { id: 'cdav_1', username: 'good@example.org', password: 'good-pw' },
    { id: 'cdav_2', username: 'empty@example.org', password: '' },
  ]);
  const execFileFn = (file, args, options, callback) => {
    const stdin = {
      on() {},
      end(data) {
        queueMicrotask(() => {
          if (args[0] === 'store') return callback(null, '', '');
          // lookup: echo back whatever was most recently stored for cdav_1 in this fake
          callback(null, 'good-pw', '');
        });
      },
    };
    return { stdin };
  };
  const result = await migratePlaintextPasswords(store, { execFileFn });
  assert.deepEqual(result, { migrated: 1, skipped: 1, failed: 0 });
  assert.equal(store.accounts[0].password, '');
  assert.equal(store.accounts[1].password, '');
});

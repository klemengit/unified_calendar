import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// CalDAV passwords live in gnome-keyring, reached via `secret-tool` (from the libsecret
// package). Every function here fails soft: no `secret-tool`, a locked keyring, a non-zero
// exit — none of it may throw or crash the app. Callers fall back to the plaintext password
// field in settings.json, which is why this file exists at all rather than just deleting that
// field outright. Two things never happen anywhere below: a shell (execFile only, args only
// ever carry the account id / username — never a shell string) and the password on argv (argv
// is world-readable via /proc on this machine; the password only ever travels on stdin).

const SERVICE = 'unified_calendar';
const TIMEOUT_MS = 10_000;

function attrs(accountId, username) {
  return ['service', SERVICE, 'account', String(accountId), 'username', String(username)];
}

// One console.error per failing call — enough to notice, not a stack trace. Only ever a fixed
// literal string, never execFile's stdout/stderr: secret-tool doesn't echo secrets on error, but
// keeping every logged string to a literal removes any doubt a password fragment could leak here.
function warnUnavailable(reason) {
  console.error(`[secrets] keyring unavailable (${reason}) — falling back to plaintext password`);
}

// Runs `secret-tool <args>`, feeding `input` on stdin when given. `execFileFn` defaults to the
// real execFile and is swapped for a fake in tests, so no test here ever touches the real keyring.
function runSecretTool(args, input, execFileFn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFileFn('secret-tool', args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
        resolve({
          notFound: error?.code === 'ENOENT',
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      });
    } catch {
      // execFile only throws synchronously for a malformed call, never for a missing binary —
      // treat it the same as "not found" rather than let it escape uncaught.
      resolve({ notFound: true, code: null, stdout: '', stderr: '' });
      return;
    }
    if (!child?.stdin) return; // the callback above still resolves this promise
    child.stdin.on('error', () => {}); // e.g. EPIPE if secret-tool has already exited
    child.stdin.end(input ?? '');
  });
}

/** The stored password for a CalDAV account, or null if there isn't one / the keyring is unreachable. */
export async function getPassword(accountId, username, { execFileFn = execFile } = {}) {
  const result = await runSecretTool(['lookup', ...attrs(accountId, username)], undefined, execFileFn);
  if (result.notFound) {
    warnUnavailable('secret-tool not found');
    return null;
  }
  if (result.code !== 0) return null; // no entry yet, or a locked keyring — not fatal either way
  return result.stdout;
}

/** Stores (or replaces) a CalDAV account's password. The password travels on stdin only. */
export async function setPassword(accountId, username, password, { execFileFn = execFile } = {}) {
  const label = `unified_calendar CalDAV (${username})`;
  const result = await runSecretTool(
    ['store', `--label=${label}`, ...attrs(accountId, username)],
    password,
    execFileFn
  );
  if (result.notFound) warnUnavailable('secret-tool not found');
  else if (result.code !== 0) warnUnavailable('secret-tool store failed');
}

/** Removes a CalDAV account's stored password, if any. */
export async function deletePassword(accountId, username, { execFileFn = execFile } = {}) {
  const result = await runSecretTool(['clear', ...attrs(accountId, username)], undefined, execFileFn);
  if (result.notFound) warnUnavailable('secret-tool not found');
  // A non-zero exit otherwise just means there was nothing to clear.
}

// True if a `secret-tool` executable exists on PATH. A plain PATH scan rather than a spawn: it's
// synchronous, can't hang on a wedged D-Bus call, and is trivially fakeable in tests via
// `env`/`accessSync` instead of touching the real filesystem or PATH.
export function secretToolAvailable({ env = process.env, accessSync = fs.accessSync } = {}) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      accessSync(path.join(dir, 'secret-tool'), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The password callers should use for a CalDAV account: the keyring copy when one exists, else
 * the plaintext settings.json field (pre-migration, or no keyring on this machine at all). Every
 * caller that needs an account's password should go through this instead of reading
 * `account.password` directly, so a migrated account keeps working unchanged.
 */
export async function resolveCaldavPassword(account, opts = {}) {
  if (!account) return null;
  const fromKeyring = await getPassword(account.id, account.username, opts);
  if (fromKeyring) return fromKeyring;
  return typeof account.password === 'string' ? account.password : null;
}

/**
 * Puts already-migrated passwords back into the in-memory accounts at startup, so every CalDAV
 * caller can go on reading `account.password` with no idea the keyring exists. Runs after
 * migratePlaintextPasswords; the store deliberately keeps these values out of settings.json.
 */
export async function hydrateKeyringPasswords(store, opts = {}) {
  let hydrated = 0;
  let missing = 0;
  for (const account of store.getCaldavAccounts()) {
    // A non-empty plaintext password means this account never migrated (no keyring on this box) —
    // it is already the working credential, so leave it be.
    if (typeof account.password === 'string' && account.password !== '') continue;
    const stored = await getPassword(account.id, account.username, opts);
    if (stored) {
      store.hydrateCaldavPassword(account.id, stored);
      hydrated++;
    } else {
      missing++; // migrated once, but the keyring cannot be read now — CalDAV will fail loudly
    }
  }
  if (missing > 0) {
    console.error(`[secrets] ${missing} CalDAV account(s) have no readable password — check the keyring`);
  }
  return { hydrated, missing };
}

// Moves every CalDAV account's plaintext password into the keyring, once, at server start. Takes
// the store's own functions rather than importing store.js, so this is unit-testable against a
// fake store without ever touching settings.json. The one rule that matters: never blank
// settings.json's copy unless the keyring read-back came back byte-for-byte identical — a
// migration that "succeeds" but silently drops the password would destroy the user's only copy
// of it, which is worse than never migrating at all.
export async function migratePlaintextPasswords(store, opts = {}) {
  const accounts = store.getCaldavAccounts();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const account of accounts) {
    const plaintext = account.password;
    if (typeof plaintext !== 'string' || plaintext === '') {
      skipped++; // nothing to migrate — also how a second run is idempotent
      continue;
    }
    try {
      await setPassword(account.id, account.username, plaintext, opts);
      const readBack = await getPassword(account.id, account.username, opts);
      if (readBack === plaintext) {
        store.clearCaldavPassword(account.id);
        migrated++;
      } else {
        failed++; // store silently failed, or read back something else — plaintext stays put
      }
    } catch {
      failed++;
    }
  }
  console.error(`[secrets] password migration: ${migrated} migrated, ${skipped} skipped, ${failed} failed`);
  return { migrated, skipped, failed };
}

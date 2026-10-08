process.env.TZ = 'Europe/Ljubljana';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-calendar-pw-test-'));
  tempDirs.push(dir);
  return dir;
}

// A store seeded with one CalDAV account that still holds a plaintext password, i.e. the
// pre-migration state every existing install is in.
async function storeWithAccount() {
  const dir = await makeTempDir();
  process.env.UNIFIED_CALENDAR_DATA_DIR = dir;
  await fs.writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      caldavAccounts: [
        {
          id: 'cdav_1',
          server: 'https://dav.example.org',
          username: 'someone@example.org',
          password: 'hunter2',
          displayName: 'someone@example.org',
          calendars: [{ id: 'cdav_1_a', url: 'https://dav.example.org/caldav/a/', name: 'Cal', selected: true }],
        },
      ],
    }),
    'utf8'
  );
  const mod = await import(`../src/store.js?t=${Date.now()}-${Math.random()}`);
  mod.loadSettings();
  return { mod, dir };
}

async function readSettings(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
}

test('clearCaldavPassword: removes the plaintext password from settings.json', async () => {
  const { mod, dir } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  const onDisk = await readSettings(dir);
  assert.equal(onDisk.caldavAccounts[0].password, '');
});

test('clearCaldavPassword: leaves the rest of the account intact', async () => {
  const { mod, dir } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  const account = (await readSettings(dir)).caldavAccounts[0];
  assert.equal(account.username, 'someone@example.org');
  assert.equal(account.server, 'https://dav.example.org');
  assert.equal(account.calendars.length, 1);
});

test('clearCaldavPassword: unknown id is a no-op, not a throw', async () => {
  const { mod, dir } = await storeWithAccount();
  assert.equal(mod.clearCaldavPassword('cdav_nope'), null);
  assert.equal((await readSettings(dir)).caldavAccounts[0].password, 'hunter2');
});

test('hydrateCaldavPassword: the password is readable in memory', async () => {
  const { mod } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  mod.hydrateCaldavPassword('cdav_1', 'from-keyring');
  assert.equal(mod.getCaldavAccount('cdav_1').password, 'from-keyring');
});

test('hydrateCaldavPassword: never writes the password to disk itself', async () => {
  const { mod, dir } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  mod.hydrateCaldavPassword('cdav_1', 'from-keyring');
  assert.equal((await readSettings(dir)).caldavAccounts[0].password, '');
});

// The regression this whole mechanism exists for: starring an event persists settings, and a
// hydrated password must not ride along with that write.
test('a later persist (starring an event) does not leak a hydrated password back to disk', async () => {
  const { mod, dir } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  mod.hydrateCaldavPassword('cdav_1', 'from-keyring');

  mod.setEventImportant('ics-f1-abc', true);

  const onDisk = await readSettings(dir);
  assert.equal(onDisk.caldavAccounts[0].password, '', 'password must not reappear in settings.json');
  assert.ok(onDisk.importantEvents.includes('ics-f1-abc'), 'the star itself still persisted');
  assert.equal(mod.getCaldavAccount('cdav_1').password, 'from-keyring', 'still usable in memory');
});

test('other settings writes also keep the password off disk', async () => {
  const { mod, dir } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  mod.hydrateCaldavPassword('cdav_1', 'from-keyring');

  mod.updateCaldavCalendar('cdav_1_a', { color: '#123456' });
  mod.updateSettings({ firstDay: 0 });

  const onDisk = await readSettings(dir);
  assert.equal(onDisk.caldavAccounts[0].password, '');
  assert.equal(onDisk.caldavAccounts[0].calendars[0].color, '#123456');
});

test('an un-migrated account still keeps its plaintext password on disk', async () => {
  // Fail-soft: with no keyring, the password has nowhere else to live and must not be dropped.
  const { mod, dir } = await storeWithAccount();
  mod.setEventImportant('ics-f1-abc', true);
  assert.equal((await readSettings(dir)).caldavAccounts[0].password, 'hunter2');
});

test('hydrateCaldavPassword: ignores an empty or non-string password', async () => {
  const { mod } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  assert.equal(mod.hydrateCaldavPassword('cdav_1', ''), null);
  assert.equal(mod.hydrateCaldavPassword('cdav_1', undefined), null);
  assert.equal(mod.getCaldavAccount('cdav_1').password, '');
});

test('removeCaldavAccount: forgets the keyring-backed marking with the account', async () => {
  const { mod, dir } = await storeWithAccount();
  mod.clearCaldavPassword('cdav_1');
  mod.removeCaldavAccount('cdav_1');
  const onDisk = await readSettings(dir);
  assert.equal(onDisk.caldavAccounts.length, 0);
});

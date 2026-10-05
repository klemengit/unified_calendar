process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('calendar-list.js listCalendars: shape/order for a representative mix of a connected provider, an ICS feed, and CalDAV calendars', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-calendar-list-calendars-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  process.env.UNIFIED_CALENDAR_DATA_DIR = dir;

  const store = await import('../src/store.js');
  store.addFeed({ url: 'https://example.com/feed.ics', name: 'Team Feed', color: '#9333ea' });
  const account = store.addCaldavAccount({
    server: 'https://dav.example.com',
    username: 'u',
    password: 'p',
    displayName: 'Home',
    calendars: [],
  });
  store.setCaldavCalendars(account.id, [
    { id: `${account.id}_cal1`, url: 'https://dav.example.com/cal1', name: 'Personal', color: '#0891b2', selected: true, visible: true },
    { id: `${account.id}_cal2`, url: 'https://dav.example.com/cal2', name: 'Not selected', color: '#0891b2', selected: false, visible: true },
  ]);

  const { listCalendars } = await import('../src/calendar-list.js');

  const calendars = listCalendars({
    tokens: {
      microsoft: { email: 'me@example.com' },
      google: { email: 'me@gmail.com' },
    },
  });

  assert.deepEqual(
    calendars.map((c) => ({ id: c.id, kind: c.kind, name: c.name, color: c.color })),
    [
      { id: 'microsoft', kind: 'provider', name: 'me@example.com', color: store.getSettings().providers.microsoft.color },
      { id: 'gcal_primary', kind: 'google-sub', name: 'me@gmail.com', color: store.getSettings().providers.google.color },
      { id: 'f1', kind: 'ics', name: 'Team Feed', color: '#9333ea' },
      { id: `${account.id}_cal1`, kind: 'caldav-sub', name: 'Personal', color: '#0891b2' },
    ]
  );
  // The editor only offers moves between calendars of one account, so it needs to know which.
  assert.equal(calendars.find((c) => c.kind === 'caldav-sub').accountId, account.id);
  // The unselected CalDAV calendar must never be exposed.
  assert.ok(!calendars.some((c) => c.name === 'Not selected'));
});

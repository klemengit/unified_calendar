process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { moveCalDavEvent } from '../src/caldav.js';

test('caldav.js moveCalDavEvent: sends one MOVE from the source resource to the same UID in the target calendar, without overwriting', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, destination: req.headers.destination, overwrite: req.headers.overwrite });
    res.statusCode = 201;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  await moveCalDavEvent({ username: 'u', password: 'p' }, 'abc-123', `${base}/cal/main/`, `${base}/cal/fyi/`);

  assert.deepEqual(seen, [
    { method: 'MOVE', url: '/cal/main/abc-123.ics', destination: `${base}/cal/fyi/abc-123.ics`, overwrite: 'F' },
  ]);
});

test('caldav.js moveCalDavEvent: a refused MOVE throws, so the edit is not saved to the wrong calendar', async (t) => {
  const server = http.createServer((req, res) => { res.statusCode = 412; res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  await assert.rejects(moveCalDavEvent({ username: 'u', password: 'p' }, 'abc-123', `${base}/a/`, `${base}/b/`));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import express from 'express';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The default bind address is a security boundary, not a preference: with no AUTH_PASSWORD there
// is no login at all, and data/settings.json always holds OAuth refresh tokens in plaintext (and
// the CalDAV password too, without a system keyring). These check the behaviour an attacker would
// meet, not the text of config.js.

/** A bare server bound the way server.js binds it, so the assertion is about listen(), not routes. */
async function listenLike(host) {
  const app = express();
  app.get('/probe', (req, res) => res.json({ ok: true }));
  const server = app.listen(0, host);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

/** Resolves to true if a TCP connect to host:port succeeds within the timeout. */
function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** A non-loopback IPv4 address of this machine, or null when there is none to test against. */
function externalAddress() {
  const nets = Object.values(os.networkInterfaces()).flat();
  const match = nets.find((n) => n && n.family === 'IPv4' && !n.internal);
  return match ? match.address : null;
}

test('config: the default bind address is loopback', async () => {
  const { config } = await import(`../src/config.js?t=${Date.now()}`);
  assert.equal(
    config.host,
    '127.0.0.1',
    'binding every interface exposes an unauthenticated calendar to the local network'
  );
});

test('config: HOST overrides the default, so a server deployment stays a config change', async () => {
  const previous = process.env.HOST;
  process.env.HOST = '0.0.0.0';
  try {
    const { config } = await import(`../src/config.js?t=${Date.now()}-host`);
    assert.equal(config.host, '0.0.0.0');
  } finally {
    if (previous === undefined) delete process.env.HOST;
    else process.env.HOST = previous;
  }
});

test('a server bound to the default host is unreachable from a non-loopback address', async (t) => {
  const external = externalAddress();
  if (!external) return t.skip('no non-loopback IPv4 address on this machine');

  const { server, port } = await listenLike('127.0.0.1');
  t.after(() => server.close());

  assert.equal(await canConnect('127.0.0.1', port), true, 'loopback must still work');
  assert.equal(
    await canConnect(external, port),
    false,
    `bound to 127.0.0.1 but answered on ${external} — the loopback default is not holding`
  );
});

test('a server bound to 0.0.0.0 IS reachable from a non-loopback address', async (t) => {
  // The control: without this, the test above would pass even if listen() ignored its host
  // argument and nothing were actually reachable for an unrelated reason (a firewall, say).
  const external = externalAddress();
  if (!external) return t.skip('no non-loopback IPv4 address on this machine');

  const { server, port } = await listenLike('0.0.0.0');
  t.after(() => server.close());

  assert.equal(await canConnect(external, port), true, `0.0.0.0 did not answer on ${external}`);
});

test('server.js passes the configured host to app.listen', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.match(
    src,
    /app\.listen\(\s*config\.port\s*,\s*config\.host/,
    'app.listen(config.port) alone binds every interface, whatever config.host says'
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome } from './helpers/test-home.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('gipity logout clears auth and prints email when logged in', async () => {
  const home = makeAuthedHome({ email: 'ec-test@914-6.com' });
  const r = await runCliAsync(['logout'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Logged out \(ec-test@914-6\.com\)/);
});

test('gipity logout prints not-logged-in when no auth file present', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gipity-logout-'));
  const r = await runCliAsync(['logout'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Not logged in/);
});

test('gipity logout --json reports the cleared session as one JSON object', async () => {
  const home = makeAuthedHome({ email: 'ec-test@914-6.com' });
  const r = await runCliAsync(['logout', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { loggedOut: true, email: 'ec-test@914-6.com' });
  const again = await runCliAsync(['logout', '--json'], { env: { HOME: home } });
  assert.deepEqual(JSON.parse(again.stdout), { loggedOut: false, email: null });
});

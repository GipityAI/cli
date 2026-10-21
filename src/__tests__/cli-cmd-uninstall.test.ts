/**
 * `gipity uninstall --json` can't share stdout with the y/N prompt, so it
 * refuses to run without --yes. (The full uninstall isn't exercised here: it
 * disables the real OS autostart service, which a test must not touch.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome } from './helpers/test-home.js';

test('gipity uninstall --json without --yes refuses and leaves ~/.gipity in place', async () => {
  const home = makeAuthedHome();
  const r = await runCliAsync(['uninstall', '--json'], { env: { HOME: home } });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /uninstall --json needs --yes/);
  assert.ok(existsSync(join(home, '.gipity', 'auth.json')), 'nothing was removed');
});

/**
 * `gipity push --json`: one JSON result naming what was uploaded and what was
 * out of sync scope (ignored paths are skipped, not silently "pushed").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

test('gipity push --json lists an ignored scratch file as skipped', async () => {
  const home = makeAuthedHome();
  const dir = makeProjectDir();
  mkdirSync(join(dir, 'tmp'));
  writeFileSync(join(dir, 'tmp', 'scratch.txt'), 'x');
  const r = await runCliAsync(['push', 'tmp/scratch.txt', '--json'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { pushed: [], skipped: ['tmp/scratch.txt'] });
});

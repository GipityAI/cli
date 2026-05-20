/**
 * gipity logs - this is the SECOND command exercised after the logs.ts
 * field-name bug fix (log.error -> log.error_message). The test asserts
 * the error_message actually surfaces in the output, which is what was
 * silently swallowed before.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity logs fn <name> shows the function error_message when present', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { id: '1', status: 'error', duration_ms: 120, trigger_type: 'http', limits_consumed: null, error_message: 'something exploded', created_at: '2026-05-01T10:00:00Z' },
    { id: '2', status: 'success', duration_ms: 50, trigger_type: 'http', limits_consumed: null, error_message: null, created_at: '2026-05-01T11:00:00Z' },
  ] } });
  const r = await fresh(['logs', 'fn', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /something exploded/);
  assert.match(r.stdout, /success/);
  assert.match(r.stdout, /error/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity logs fn <name> prints empty-history message when no entries', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [] } });
  const r = await fresh(['logs', 'fn', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No logs for function "hello"/);
});

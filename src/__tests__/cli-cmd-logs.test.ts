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

function fresh(args: string[], env: Record<string, string> = {}) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home, ...env }, cwd: d });
}

test('gipity logs fn <name> shows the function error_message when present', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { id: '1', status: 'error', duration_ms: 120, trigger_type: 'http', limits_consumed: null, error_message: 'something exploded', created_at: '2026-05-01T10:00:00Z' },
    { id: '2', status: 'ok', duration_ms: 50, trigger_type: 'http', limits_consumed: null, error_message: null, created_at: '2026-05-01T11:00:00Z' },
  ] } });
  const r = await fresh(['logs', 'fn', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /something exploded/);
  assert.match(r.stdout, /ok/);
  assert.match(r.stdout, /error/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity logs fn <name> renders captured console.log/warn/error lines (WT-363)', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { id: '1', status: 'ok', duration_ms: 50, trigger_type: 'http', limits_consumed: null, error_message: null,
      logs: [
        { level: 'log', message: 'order 42 created', timestamp: 1 },
        { level: 'warn', message: 'low stock', timestamp: 2 },
        { level: 'error', message: 'charge failed', timestamp: 3 },
      ],
      created_at: '2026-05-01T11:00:00Z' },
  ] } });
  const r = await fresh(['logs', 'fn', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /order 42 created/);
  assert.match(r.stdout, /warn: low stock/);
  assert.match(r.stdout, /error: charge failed/);
});

test('gipity logs fn <name> --json passes the logs array through verbatim', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { id: '1', status: 'ok', duration_ms: 50, trigger_type: 'http', limits_consumed: null, error_message: null,
      logs: [{ level: 'log', message: 'hi', timestamp: 1 }], created_at: '2026-05-01T11:00:00Z' },
  ] } });
  const r = await fresh(['logs', 'fn', 'hello', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed[0].logs, [{ level: 'log', message: 'hi', timestamp: 1 }]);
});

test('gipity logs fn <name> prints empty-history message when no entries', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [] } });
  const r = await fresh(['logs', 'fn', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No logs for function "hello"/);
});

// The runtime writes 'ok' | 'error' | 'limit_exceeded' and has never written
// 'success'. The CLI matched on 'success', so every healthy invocation fell to
// the warning colour and a clean function log read as if something were wrong.
test('gipity logs fn <name> paints an ok status green, not the warning colour', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { id: '1', status: 'ok', duration_ms: 9, trigger_type: 'http', limits_consumed: null, error_message: null, created_at: '2026-05-01T11:00:00Z' },
  ] } });
  const r = await fresh(['logs', 'fn', 'hello'], { NO_COLOR: '', FORCE_COLOR: '1' });
  assert.equal(r.status, 0, r.stderr);
  const okLine = r.stdout.split('\n').find((l) => l.includes('ok'))!;
  assert.match(okLine, /\x1b\[(32|92)m/, 'ok must render in the success (green) colour');
  assert.doesNotMatch(okLine, /\x1b\[(33|93)m/, 'ok must not render in the warning (yellow) colour');
});

test('gipity logs fn <name> still paints error red and limit_exceeded as a warning', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { id: '1', status: 'error', duration_ms: 9, trigger_type: 'http', limits_consumed: null, error_message: 'boom', created_at: '2026-05-01T11:00:00Z' },
    { id: '2', status: 'limit_exceeded', duration_ms: 9, trigger_type: 'http', limits_consumed: null, error_message: null, created_at: '2026-05-01T11:00:00Z' },
  ] } });
  const r = await fresh(['logs', 'fn', 'hello'], { NO_COLOR: '', FORCE_COLOR: '1' });
  assert.equal(r.status, 0, r.stderr);
  const errLine = r.stdout.split('\n').find((l) => l.includes('error'))!;
  const limLine = r.stdout.split('\n').find((l) => l.includes('limit_exceeded'))!;
  assert.match(errLine, /\x1b\[(31|91)m/);
  assert.match(limLine, /\x1b\[(33|93)m/);
});

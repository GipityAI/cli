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

test('gipity fn list shows functions with name/version/auth/timeout', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions', { body: { data: [
    { name: 'hello', version: 3, auth_level: 'public', timeout_ms: 5000, description: 'Greets the world' },
    { name: 'secret', version: 1, auth_level: 'user', timeout_ms: 30000, description: null },
  ] } });
  const r = await fresh(['fn', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello/);
  assert.match(r.stdout, /v3/);
  assert.match(r.stdout, /public/);
  assert.match(r.stdout, /timeout=5000ms/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn logs <name> shows status + duration + error_message', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { status: 'success', duration_ms: 42, trigger_type: 'http', error_message: null, created_at: '2026-05-01T10:00:00Z' },
    { status: 'error',   duration_ms: 100, trigger_type: 'http', error_message: 'boom', created_at: '2026-05-02T10:00:00Z' },
  ] } });
  const r = await fresh(['fn', 'logs', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /success/);
  assert.match(r.stdout, /42ms/);
  assert.match(r.stdout, /error/);
  assert.match(r.stdout, /boom/); // catches the field-name bug we fixed earlier
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn call <name> posts and prints JSON', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/hello', { body: { data: { greeting: 'Hello!' } } });
  const r = await fresh(['fn', 'call', 'hello', '{"name":"world"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hello/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn delete <name> --yes DELETEs the function', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/functions/hello', { body: { data: { name: 'hello', deleted: true } } });
  const r = await fresh(['fn', 'delete', 'hello', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted function 'hello'/);
  const reqs = mock.requests();
  assert.ok(reqs.some(q => q.method === 'DELETE' && q.url === '/projects/p_TestProj/functions/hello'), 'expected a DELETE request');
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn rm <name> --yes is an alias for delete', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/functions/hello', { body: { data: { name: 'hello', deleted: true } } });
  const r = await fresh(['fn', 'rm', 'hello', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted function 'hello'/);
});

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

test('gipity rbac list shows policies', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/rbac', { body: { data: [
    { role: 'editor', operation: 'select', table_name: 'incidents', row_condition: 'team_id=$caller_id', allowed_columns: ['id', 'title'], readonly_columns: [] },
  ] } });
  const r = await fresh(['rbac', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /editor can select on incidents/);
  assert.match(r.stdout, /WHERE team_id=\$caller_id/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity rbac create POSTs and prints created', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/rbac', { status: 201, body: { data: { id: 'rbac_x' } } });
  const r = await fresh(['rbac', 'create', 'incidents', '--role', 'editor', '--op', 'select']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Policy created/);
});

test('gipity rbac delete --yes calls DELETE', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/rbac', { body: { data: { deleted: true } } });
  const r = await fresh(['--yes', 'rbac', 'delete', 'incidents', '--role', 'editor', '--op', 'select']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Policy deleted/);
});

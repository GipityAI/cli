import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;
let projectDir: string;

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
  projectDir = makeProjectDir({ apiBase: mock.apiBase });
});

after(async () => { await mock.stop(); });

function inProject(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: projectDir });
}

test('gipity db list (project-scoped) prints friendly names', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/databases', { body: { data: [
    { friendlyName: 'main', internalName: 'ecu_x', projectGuid: 'p_TestProj' },
    { friendlyName: 'analytics', internalName: 'ecu_y', projectGuid: 'p_TestProj' },
  ] } });
  const r = await inProject(['db', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /main/);
  assert.match(r.stdout, /analytics/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity db list (project-scoped, empty) points at --all for the account cap', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/databases', { body: { data: [] } });
  const r = await inProject(['db', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gipity db list --all/);
});

test('gipity db list --all shows count/limit and groups by project', async () => {
  mock.reset();
  mock.on('GET /users/me/databases', { body: { data: {
    databases: [
      { friendlyName: 'main', projectGuid: 'p_TestProj', projectName: 'Test', projectSlug: 'test-project' },
      { friendlyName: 'logs', projectGuid: 'p_OtherProj', projectName: 'Other', projectSlug: 'other' },
    ],
    count: 2,
    limit: 25,
  } } });
  const r = await inProject(['db', 'list', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Databases:\s*2\/25/);
  assert.match(r.stdout, /test-project/);
  assert.match(r.stdout, /main/);
  assert.match(r.stdout, /other/);
  assert.match(r.stdout, /logs/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity db query <sql> prints rows in tabular form', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/databases', { body: { data: [
    { friendlyName: 'main', internalName: 'ecu_x', projectGuid: 'p_TestProj' },
  ] } });
  mock.on('POST /projects/p_TestProj/db/query', { body: { data: {
    rows: [
      { id: 1, name: 'foo' },
      { id: 2, name: 'bar' },
    ],
  } } });
  const r = await inProject(['db', 'query', 'SELECT * FROM things']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /id\tname/);
  assert.match(r.stdout, /1\tfoo/);
  assert.match(r.stdout, /2\tbar/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity db query reports affected rows for DML', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/databases', { body: { data: [
    { friendlyName: 'main', internalName: 'ecu_x', projectGuid: 'p_TestProj' },
  ] } });
  mock.on('POST /projects/p_TestProj/db/query', { body: { data: { affectedRows: 3 } } });
  const r = await inProject(['db', 'query', "UPDATE things SET name='baz'"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Affected rows:\s*3/);
});

test('gipity db drop --yes (project-scoped) calls db/manage and prints dropped', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/db/manage', { body: { data: { success: true } } });
  const r = await inProject(['--yes', 'db', 'drop', 'main']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dropped database 'main'/);
});

test('gipity db drop --yes --project <slug> uses the account-level drop endpoint', async () => {
  mock.reset();
  mock.on('GET /users/me/databases', { body: { data: {
    databases: [{ friendlyName: 'main', projectGuid: 'p_OtherProj', projectName: 'O', projectSlug: 'other' }],
    count: 1, limit: 25,
  } } });
  mock.on('POST /users/me/databases/drop', { body: { data: { success: true } } });
  const r = await inProject(['--yes', 'db', 'drop', 'main', '--project', 'other']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dropped database 'main'/);
});

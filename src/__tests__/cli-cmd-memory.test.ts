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
  const d = makeProjectDir({ apiBase: mock.apiBase, agentGuid: 'a_TestAgnt' });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity memory list shows agent memory topics', async () => {
  mock.reset();
  mock.on('GET /agents/a_TestAgnt/memory', { body: { data: [
    { topic: 'main', content: 'hi', updated_at: '2026-05-01T00:00:00Z' },
    { topic: 'preferences', content: 'foo', updated_at: '2026-05-02T00:00:00Z' },
  ] } });
  const r = await fresh(['memory', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /main/);
  assert.match(r.stdout, /preferences/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity memory list --project hits the project memory endpoint', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/memory', { body: { data: [
    { topic: 'overview', content: 'x', updated_at: '2026-05-01T00:00:00Z' },
  ] } });
  const r = await fresh(['memory', 'list', '--project']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /overview/);
});

test('gipity memory read <topic> prints content', async () => {
  mock.reset();
  mock.on('GET /agents/a_TestAgnt/memory', { body: { data: [
    { topic: 'main', content: 'Remember the alpha launch date.', updated_at: '2026-05-01T00:00:00Z' },
  ] } });
  const r = await fresh(['memory', 'read', 'main']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha launch date/);
});

test('gipity memory write <topic> <content> PUTs and prints written', async () => {
  mock.reset();
  mock.on('PUT /agents/a_TestAgnt/memory/notes', { body: { data: { success: true } } });
  const r = await fresh(['memory', 'write', 'notes', 'remember this']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Wrote "notes"/);
});

test('gipity memory delete --yes calls DELETE', async () => {
  mock.reset();
  mock.on('DELETE /agents/a_TestAgnt/memory/notes', { body: { data: { success: true } } });
  const r = await fresh(['--yes', 'memory', 'delete', 'notes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted "notes"/);
});

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

test('gipity chat <message> posts and prints agent response', async () => {
  mock.reset();
  mock.on('POST /conversations', { body: { data: {
    content: 'Hello back!',
    conversationGuid: 'c_NewConv001',
    messageGuid: 'm_New000000',
    model: 'claude-sonnet-4-6',
    inputTokens: 10, outputTokens: 5, costUsd: 0.0001,
    filesChanged: false,
    toolsUsed: [],
  } } });
  const r = await fresh(['chat', 'Hi there']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hello back!/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity chat list shows recent conversations', async () => {
  mock.reset();
  mock.on('GET /conversations', { body: { data: [
    { short_guid: 'c_Conv00001', title: 'Bug triage', updated_at: '2026-05-01T00:00:00Z' },
    { short_guid: 'c_Conv00002', title: null, updated_at: '2026-04-01T00:00:00Z' },
  ] } });
  const r = await fresh(['chat', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /c_Conv00001/);
  assert.match(r.stdout, /Bug triage/);
  assert.match(r.stdout, /\(untitled\)/);
});

test('gipity chat rename <guid> <title> sends PUT and prints renamed', async () => {
  mock.reset();
  mock.on('PUT /conversations/c_Conv00001', { body: { data: { renamed: true } } });
  const r = await fresh(['chat', 'rename', 'c_Conv00001', 'New', 'title']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed c_Conv00001/);
});

test('gipity chat archive <guid> sends PUT', async () => {
  mock.reset();
  mock.on('PUT /conversations/c_Conv00001', { body: { data: { archived: true } } });
  const r = await fresh(['chat', 'archive', 'c_Conv00001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Archived c_Conv00001/);
});

test('gipity chat delete <guid> sends DELETE', async () => {
  mock.reset();
  mock.on('DELETE /conversations/c_Conv00001', { body: { data: { deleted: true } } });
  const r = await fresh(['chat', 'delete', 'c_Conv00001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted c_Conv00001/);
});

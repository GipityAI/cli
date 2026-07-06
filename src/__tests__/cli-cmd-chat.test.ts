import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

test('gipity chat rename --guid <guid> <title> sends PUT and prints renamed', async () => {
  mock.reset();
  mock.on('PUT /conversations/c_Conv00001', { body: { data: { renamed: true } } });
  const r = await fresh(['chat', 'rename', '--guid', 'c_Conv00001', 'New', 'title']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed chat/);
});

test('gipity chat rename with no current chat and no --guid errors', async () => {
  mock.reset();
  const r = await fresh(['chat', 'rename', 'New', 'title']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No current chat/);
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

test('gipity chat in a non-project dir falls back to the Home project and writes no .gipity.json', async () => {
  mock.reset();
  // No .gipity.json in cwd or any ancestor → resolveProjectContext hits the
  // server's Home project (one-off mode).
  mock.on('GET /projects/default', { body: { data: {
    projectGuid: 'p_HomeProj00',
    projectSlug: 'home',
    projectName: 'Home',
    accountSlug: 'acct',
    agentGuid: 'a_HomeAgent0',
  } } });
  mock.on('POST /conversations', { body: { data: {
    content: 'Hi from Home!',
    conversationGuid: 'c_OneOff0001',
    messageGuid: 'm_OneOff0001',
    model: 'claude-sonnet-4-6',
    inputTokens: 1, outputTokens: 1, costUsd: 0,
    filesChanged: false,
    toolsUsed: [],
  } } });

  const dir = mkdtempSync(join(tmpdir(), 'gipity-cli-oneoff-'));
  const r = await runCliAsync(['--api-base', mock.apiBase, 'chat', 'Hello'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hi from Home!/);
  // The one-off guard must not persist the conversation guid by materializing
  // a project config in an unrelated directory.
  assert.equal(
    existsSync(join(dir, '.gipity.json')), false,
    'one-off chat must not create a .gipity.json in cwd',
  );
});

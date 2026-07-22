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

// All records commands hit the app API (/api/<guid>/records/...), the only
// records surface that exists server-side. (The old /projects/<guid>/records-*
// paths never existed and 404'd.)
test('gipity records list shows configured tables', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/records-config', { body: { data: [
    { table_name: 'incidents', auth_level: 'user', primary_key_column: 'id', database_name: 'main' },
    { table_name: 'comments',  auth_level: 'public', primary_key_column: 'id', database_name: 'main' },
  ] } });
  const r = await fresh(['records', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /incidents/);
  assert.match(r.stdout, /pk=id/);
  assert.match(r.stdout, /db=main/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity records config <table> --auth public PATCHes the table config', async () => {
  mock.reset();
  mock.on('PATCH /api/p_TestProj/records/incidents/config', { body: { data: {
    table_name: 'incidents', auth_level: 'public', searchable: false, primary_key_column: 'id',
  } } });
  const r = await fresh(['records', 'config', 'incidents', '--auth', 'public']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /auth=public/);
});

test('gipity records config <table> with no flags shows current config', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/records/incidents/config', { body: { data: {
    table_name: 'incidents', auth_level: 'member', searchable: false,
  } } });
  const r = await fresh(['records', 'config', 'incidents']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /member/);
});

test('gipity records query <table> prints total + rows as JSON lines', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/records/incidents', { body: {
    data: [{ id: 1, title: 'Disk full' }, { id: 2, title: 'Auth bug' }],
    meta: { total: 2 },
  } });
  const r = await fresh(['records', 'query', 'incidents']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 total records/);
  assert.match(r.stdout, /Disk full/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity records get <table> <id> prints record JSON', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/records/incidents/42', { body: { data: { id: 42, title: 'Disk full' } } });
  const r = await fresh(['records', 'get', 'incidents', '42']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Disk full/);
});

test('gipity records create posts the JSON body and prints created', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/records/incidents', { status: 201, body: { data: { id: 99, title: 'New' } } });
  const r = await fresh(['records', 'create', 'incidents', '--data', '{"title":"New"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created/);
});

test('gipity records update sends PUT and prints updated', async () => {
  mock.reset();
  mock.on('PUT /api/p_TestProj/records/incidents/42', { body: { data: { id: 42, title: 'Updated' } } });
  const r = await fresh(['records', 'update', 'incidents', '42', '--data', '{"title":"Updated"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Updated/);
});

test('gipity records delete --yes calls DELETE', async () => {
  mock.reset();
  mock.on('DELETE /api/p_TestProj/records/incidents/42', { body: { data: { deleted: true } } });
  const r = await fresh(['--yes', 'records', 'delete', 'incidents', '42']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted/);
});

// Every records subcommand takes --json - a scripted probe sequence
// (create → update → delete → history) must not break on one step that lacks it.
test('gipity records delete --json emits parseable JSON, not a help dump', async () => {
  mock.reset();
  mock.on('DELETE /api/p_TestProj/records/incidents/42', { body: { data: { id: 42, deleted: true } } });
  const r = await fresh(['--yes', 'records', 'delete', 'incidents', '42', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { id: 42, deleted: true });
});

// Table-wide feed: `history <table>` with no id, the endpoint an activity view reads.
test('gipity records history <table> with no id reads the table-wide feed', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/records/incidents/history', { body: { data: [
    { created_at: '2026-07-22T20:00:00Z', source: 'api', detail: { summary: 'created incident "Disk full"' } },
  ] } });
  const r = await fresh(['records', 'history', 'incidents']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /created incident "Disk full"/);
});

// --anon exercises the signed-out visitor path: an app token is minted and no
// owner Authorization header is sent.
test('gipity records query --anon mints an app token and sends no owner auth', async () => {
  mock.reset();
  let sawAuthHeader: unknown = 'unset';
  mock.on('POST /api/token', { body: { data: { token: 'app_tok_123' } } });
  mock.on('GET /api/p_TestProj/records/incidents', (req: any) => {
    sawAuthHeader = req.headers.authorization ?? null;
    assert.equal(req.headers['x-app-token'], 'app_tok_123');
    return { body: { data: [{ id: 1, title: 'Public row' }], meta: { total: 1 } } };
  });
  const r = await fresh(['records', 'query', 'incidents', '--anon']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sawAuthHeader, null, 'anonymous call must not carry the owner Bearer token');
  assert.match(r.stdout, /Public row/);
  assert.match(r.stderr, /anonymous visitor/);
});

test('gipity records create --anon posts through the public path', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 'app_tok_123' } } });
  mock.on('POST /api/p_TestProj/records/incidents', (req: any) => {
    assert.equal(req.headers.authorization, undefined);
    return { status: 201, body: { data: { id: 7, title: 'From a visitor' } } };
  });
  const r = await fresh(['records', 'create', 'incidents', '--data', '{"title":"From a visitor"}', '--anon', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { id: 7, title: 'From a visitor' });
});

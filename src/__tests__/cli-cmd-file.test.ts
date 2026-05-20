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

test('gipity file ls lists files with sizes', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/files', { body: { data: [
    { name: 'src', type: 'directory', size: 0, modified: '2026-05-01T00:00:00Z' },
    { name: 'index.html', type: 'file', size: 1024, modified: '2026-05-01T00:00:00Z' },
  ] } });
  const r = await fresh(['file', 'ls']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\//);
  assert.match(r.stdout, /index\.html/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity file cat <path> prints file content', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/files/read', { body: { data: {
    content: '<h1>Hello</h1>', size: 14, mime: 'text/html',
  } } });
  const r = await fresh(['file', 'cat', 'index.html']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<h1>Hello<\/h1>/);
});

test('gipity file tree lists paths with sizes', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/files/tree', { body: { data: [
    { path: 'src/index.html', size: 100, type: 'file' },
    { path: 'src/css', size: 0, type: 'dir' },
  ] } });
  const r = await fresh(['file', 'tree']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\/index\.html/);
  assert.match(r.stdout, /src\/css/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity file rm <path> deletes and prints confirmation', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/files', { body: { success: true } });
  const r = await fresh(['file', 'rm', 'index.html']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted: index\.html/);
});

test('gipity file versions <path> shows version history', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/files/versions', { body: { data: [
    { version: 3, size: 100, mime: 'text/html', source: 'manual', created_at: '2026-05-01T00:00:00Z', current: true },
    { version: 2, size: 95,  mime: 'text/html', source: 'manual', created_at: '2026-04-01T00:00:00Z', current: false },
  ] } });
  const r = await fresh(['file', 'versions', 'index.html']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /v3/);
  assert.match(r.stdout, /v2/);
  assert.match(r.stdout, /current/);
});

test('gipity file restore <path> <ver> POSTs and prints restored', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/files/version-restore', { body: { data: {
    path: 'index.html', version: 2, size: 95,
  } } });
  const r = await fresh(['file', 'restore', 'index.html', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Restored index\.html to v2/);
});

test('gipity file rollback <datetime> POSTs and prints summary', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/rollback', { body: { data: {
    filesRestored: 3, filesRemoved: 1, dirsRestored: 0, dirsRemoved: 0, filesUnchanged: 5,
    resolvedDatetime: '2026-05-01T00:00:00Z',
  } } });
  const r = await fresh(['file', 'rollback', '2026-05-01T00:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rolled back/);
  assert.match(r.stdout, /3 files restored/);
});

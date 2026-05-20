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

test('gipity domain list shows project-scoped domains', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/domains', { body: { data: [
    { short_guid: 'dom_Aaa00001', domain: 'app.example.com', status: 'active', verified_at: '2026-05-01T00:00:00Z', created_at: '2026-04-01T00:00:00Z' },
  ] } });
  const r = await fresh(['domain', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /app\.example\.com/);
  assert.match(r.stdout, /active/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity domain list --all groups by project with count/limit', async () => {
  mock.reset();
  mock.on('GET /users/me/domains', { body: { data: {
    domains: [
      { shortGuid: 'dom_Aaa00001', domain: 'app.example.com', status: 'active', projectName: 'Test', projectSlug: 'test-project', createdAt: '2026-04-01T00:00:00Z' },
      { shortGuid: 'dom_Bbb00002', domain: 'docs.other.io',  status: 'pending', projectName: 'Other', projectSlug: 'other',        createdAt: '2026-04-15T00:00:00Z' },
    ],
    count: 2, limit: 10,
  } } });
  const r = await fresh(['domain', 'list', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Domains:\s*2\/10/);
  assert.match(r.stdout, /test-project/);
  assert.match(r.stdout, /other/);
  assert.match(r.stdout, /app\.example\.com/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity domain add <name> prints DNS instructions', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/domains', { body: { data: {
    domain: { short_guid: 'dom_Newdom001', domain: 'app.example.com', status: 'pending', verified_at: null, created_at: '2026-05-01T00:00:00Z' },
    instructions: { type: 'CNAME', name: 'app.example.com', target: 'custom.gipity.ai', note: 'Add this record to your DNS provider.' },
  } } });
  const r = await fresh(['domain', 'add', 'app.example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Domain "app\.example\.com" added/);
  assert.match(r.stdout, /Type:\s+CNAME/);
  assert.match(r.stdout, /Target:\s+custom\.gipity\.ai/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity domain verify <guid> activates the domain', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/domains/dom_Newdom001/verify', { body: { data: {
    domain: { short_guid: 'dom_Newdom001', domain: 'app.example.com', status: 'active', verified_at: '2026-05-01T00:00:00Z', created_at: '2026-04-01T00:00:00Z' },
    alreadyActive: false,
  } } });
  const r = await fresh(['domain', 'verify', 'dom_Newdom001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified and active/);
  assert.match(r.stdout, /https:\/\/app\.example\.com/);
});

test('gipity domain remove <guid> deletes the domain', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/domains/dom_Newdom001', { body: { data: { success: true } } });
  const r = await fresh(['domain', 'remove', 'dom_Newdom001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Domain removed/);
});

/**
 * `gipity key` - project API keys for scripts/agents (X-Api-Key). Mocked API.
 * Locks the mint-once / list / revoke surface so an agent asked for "a secret
 * key I can generate and revoke" never has to hand-roll one.
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

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity key create prints the plaintext key once + the X-Api-Key usage', async () => {
  mock.reset();
  let seenBody: any;
  mock.on('POST /projects/p_TestProj/api-keys', (req) => {
    seenBody = req.body;
    return { status: 201, body: { data: {
      short_guid: 'ak_abc12345', name: 'laptop importer', key: 'gip_PLAINTEXT123',
      prefix: 'gip_PLAI', role: 'editor', expires_at: null, created_at: '2026-01-01T00:00:00Z',
    } } };
  });

  const r = await fresh(['key', 'create', 'laptop importer', '--role', 'editor']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(seenBody, { name: 'laptop importer', role: 'editor' });
  assert.match(r.stdout, /gip_PLAINTEXT123/);
  assert.match(r.stdout, /X-Api-Key/);
  assert.match(r.stdout, /ak_abc12345/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity key create --expires-days sends expires_in_days', async () => {
  mock.reset();
  let seenBody: any;
  mock.on('POST /projects/p_TestProj/api-keys', (req) => {
    seenBody = req.body;
    return { status: 201, body: { data: {
      short_guid: 'ak_exp', name: 'cron', key: 'gip_K', prefix: 'gip_K',
      role: 'viewer', expires_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    } } };
  });

  const r = await fresh(['key', 'create', 'cron', '--expires-days', '30', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seenBody.expires_in_days, 30);
  assert.equal(JSON.parse(r.stdout.trim()).key, 'gip_K');
});

test('gipity key list shows keys; empty state points at create', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/api-keys', { body: { data: [
    { short_guid: 'ak_abc12345', name: 'laptop importer', prefix: 'gip_PLAI', role: 'editor',
      last_used_at: null, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
  ] } });
  const r = await fresh(['key', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ak_abc12345/);
  assert.match(r.stdout, /laptop importer/);
  assert.match(r.stdout, /last used never/);
  assert.doesNotMatch(r.stdout, /undefined/);

  mock.reset();
  mock.on('GET /projects/p_TestProj/api-keys', { body: { data: [] } });
  const empty = await fresh(['key', 'list']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /gipity key create/);
});

test('gipity key revoke confirms removal', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/api-keys/ak_abc12345', { body: { data: { message: 'API key revoked' } } });
  const r = await fresh(['key', 'revoke', 'ak_abc12345']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Revoked/);
  assert.match(r.stdout, /ak_abc12345/);
});

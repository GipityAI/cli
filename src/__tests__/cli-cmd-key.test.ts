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
    { short_guid: 'ak_abc12345', name: 'laptop importer', prefix: 'gip_PLAI', role: 'editor', scopes: null,
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

test('gipity key create --json prints a failure as a JSON error object', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/api-keys', { status: 409, body: { error: { code: 'VALIDATION_ERROR', message: 'API key "verify-tmp" already exists' } } });
  const r = await fresh(['key', 'create', 'verify-tmp', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.error.code, 'VALIDATION_ERROR');
  assert.match(out.error.message, /already exists/);
});

test('gipity key create sends scopes from --functions/--tables/--files/--approvals/--ip and shows them', async () => {
  mock.reset();
  let seenBody: any;
  mock.on('POST /projects/p_TestProj/api-keys', (req) => {
    seenBody = req.body;
    return { status: 201, body: { data: {
      short_guid: 'ak_dev12345', name: 'front door', key: 'gip_DEVICE', prefix: 'gip_DEVI', role: 'editor',
      scopes: (req.body as any).scopes, expires_at: null, created_at: '2026-01-01T00:00:00Z',
    } } };
  });

  const r = await fresh(['key', 'create', 'front door', '--role', 'editor',
    '--functions', 'send-command, heartbeat', '--tables', 'commands:write,logs:read',
    '--files', 'read', '--approvals', 'read', '--ip', '203.0.113.7/32,2001:db8::/48']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(seenBody.scopes, {
    functions: ['send-command', 'heartbeat'],
    tables: { commands: 'write', logs: 'read' },
    files: 'read',
    approvals: 'read',
    ip: ['203.0.113.7/32', '2001:db8::/48'],
  });
  assert.match(r.stdout, /Scopes: fn: send-command,heartbeat {2}tables: commands:write,logs:read {2}files: read {2}approvals: read {2}ip: 203\.0\.113\.7\/32,2001:db8::\/48/);
});

test('gipity key create rejects a malformed --tables entry before calling the server', async () => {
  mock.reset();
  let called = false;
  mock.on('POST /projects/p_TestProj/api-keys', () => { called = true; return { status: 201, body: { data: {} } }; });
  const r = await fresh(['key', 'create', 'bad', '--tables', 'commands:admin']);
  assert.equal(r.status, 1);
  assert.equal(called, false);
  assert.match(r.stdout + r.stderr, /table:read or table:write/);
});

test('gipity key list shows each key\'s scopes', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/api-keys', { body: { data: [
    { short_guid: 'ak_dev12345', name: 'front door', prefix: 'gip_DEVI', role: 'editor',
      scopes: { functions: ['send-command'], tables: { logs: 'read' } },
      last_used_at: null, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
    { short_guid: 'ak_full1234', name: 'laptop', prefix: 'gip_LAPT', role: 'owner', scopes: null,
      last_used_at: null, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
  ] } });
  const r = await fresh(['key', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fn: send-command {2}tables: logs:read/);
  assert.match(r.stdout, /all access/);
});

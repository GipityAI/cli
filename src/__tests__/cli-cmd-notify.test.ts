import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'fs';
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

const P8 = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n';

test('gipity notify apns set reads the .p8 file and PUTs the key to the app', async () => {
  mock.reset();
  mock.on('PUT /api/p_TestProj/services/notify/apns', {
    body: { data: { configured: true, teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'com.example.app', defaultEnvironment: 'sandbox' } },
  });
  const dir = mkdtempSync(join(tmpdir(), 'gip-apns-'));
  const p8Path = join(dir, 'AuthKey_KEY1234567.p8');
  writeFileSync(p8Path, P8);

  const r = await fresh(['notify', 'apns', 'set', '--team-id', 'TEAM123456', '--key-id', 'KEY1234567', '--p8', p8Path, '--bundle-id', 'com.example.app', '--sandbox']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /iOS push is set up/);
  assert.match(r.stdout, /com\.example\.app/);
  assert.doesNotMatch(r.stdout, /PRIVATE KEY/);

  const putReq = mock.requests().find(q => q.method === 'PUT' && q.url === '/api/p_TestProj/services/notify/apns');
  assert.ok(putReq, 'expected a PUT');
  assert.deepEqual(putReq!.body, { team_id: 'TEAM123456', key_id: 'KEY1234567', bundle_id: 'com.example.app', p8: P8, sandbox: true });
});

test('gipity notify apns set fails clearly when the .p8 file is missing', async () => {
  mock.reset();
  const r = await fresh(['notify', 'apns', 'set', '--team-id', 'TEAM123456', '--key-id', 'KEY1234567', '--p8', '/nope/AuthKey.p8', '--bundle-id', 'com.example.app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /Can't read \/nope\/AuthKey\.p8/);
  assert.equal(mock.requests().filter(q => q.method === 'PUT').length, 0);
});

test('gipity notify apns show reports an unconfigured app with the setup command', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/services/notify/apns', { body: { data: { configured: false } } });
  const r = await fresh(['notify', 'apns', 'show']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not set up/);
  assert.match(r.stdout, /gipity notify apns set/);
});

test('gipity notify apns rm deletes the key', async () => {
  mock.reset();
  mock.on('DELETE /api/p_TestProj/services/notify/apns', { body: { data: { removed: true } } });
  const r = await fresh(['notify', 'apns', 'rm']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /APNs key removed/);
});

test('gipity notify test reports web and iOS deliveries and Apple failure reasons', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/notify/send', {
    body: { data: { sent: 2, failed: 1, pruned: 0, results: [
      { transport: 'web', endpoint: 'https://push.example/1', status: 'sent' },
      { transport: 'apns', device: 'abcd1234', status: 'sent' },
      { transport: 'apns', device: 'ffff0000', status: 'failed', reason: 'TopicDisallowed' },
    ] } },
  });
  const r = await fresh(['notify', 'test', '--to', 'u_abc12345']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sent to 2 devices \(1 web, 1 iOS\)/);
  assert.match(r.stdout, /ffff0000: TopicDisallowed/);
  const post = mock.requests().find(q => q.url === '/api/p_TestProj/services/notify/send');
  assert.equal((post!.body as { to: string }).to, 'u_abc12345');
});

test('gipity notify subs splits each user by web and iOS', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/services/notify/subs', {
    body: { data: { total: 3, byUser: [{ user_guid: 'u_abc12345', count: 3, web: 1, ios: 2 }] } },
  });
  const r = await fresh(['notify', 'subs']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /u_abc12345\s+3 devices \(1 web, 2 iOS\)/);
});

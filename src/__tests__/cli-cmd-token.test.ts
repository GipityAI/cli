/**
 * Happy-path tests for `gipity token` + subcommands. Mocked API; subprocess
 * spawn. Asserts: exit 0, expected substrings, no "undefined", and that a
 * GIPITY_TOKEN env var authenticates without a saved login.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync, makeTmpHome } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => {
  await mock.stop();
});

test('gipity token create prints the token once + an export line', async () => {
  mock.reset();
  mock.on('POST /auth/agent-tokens', { body: { data: {
    token: 'gip_at_TESTTOKEN1234567890', shortGuid: 'at_abc12345', expiresAt: null,
  } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'token', 'create', '--name', 'Hermes'], { env: { HOME: home } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /gip_at_TESTTOKEN1234567890/);
  assert.match(r.stdout, /export GIPITY_TOKEN=gip_at_TESTTOKEN1234567890/);
  assert.match(r.stdout, /at_abc12345/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity token create --json emits raw API data', async () => {
  mock.reset();
  mock.on('POST /auth/agent-tokens', { body: { data: {
    token: 'gip_at_JSON', shortGuid: 'at_json1234', expiresAt: '2026-12-01T00:00:00Z',
  } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'token', 'create', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.token, 'gip_at_JSON');
  assert.equal(parsed.shortGuid, 'at_json1234');
});

test('gipity token list shows tokens with name + dates', async () => {
  mock.reset();
  mock.on('GET /auth/agent-tokens', { body: { data: [
    { short_guid: 'at_abc12345', name: 'Hermes', created_at: '2026-01-01T00:00:00Z', expires_at: null, last_used_at: '2026-06-01T00:00:00Z' },
  ] } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'token', 'list'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /at_abc12345/);
  assert.match(r.stdout, /Hermes/);
  assert.match(r.stdout, /expires never/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity token revoke confirms removal', async () => {
  mock.reset();
  mock.on('DELETE /auth/agent-tokens/at_abc12345', { body: { success: true } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'token', 'revoke', 'at_abc12345'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Revoked/);
  assert.match(r.stdout, /at_abc12345/);
});

test('GIPITY_TOKEN env authenticates with no saved login', async () => {
  mock.reset();
  let seenAuth: string | string[] | undefined;
  mock.on('GET /auth/agent-tokens', (req) => {
    seenAuth = req.headers.authorization;
    return { body: { data: [] } };
  });

  // Unauthed home (no ~/.gipity/auth.json) — only the env token can authenticate.
  const r = await runCliAsync(['--api-base', mock.apiBase, 'token', 'list'], {
    env: { HOME: makeTmpHome(), GIPITY_TOKEN: 'gip_at_ENVTOKEN' },
  });
  assert.equal(r.status, 0, `expected exit 0 via GIPITY_TOKEN, got ${r.status}\nstderr:\n${r.stderr}`);
  // The request carried the env token as the Bearer credential (no session refresh).
  assert.equal(seenAuth, 'Bearer gip_at_ENVTOKEN');
});

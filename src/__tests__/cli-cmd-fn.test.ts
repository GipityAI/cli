import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('gipity fn list shows functions with name/version/auth/timeout', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions', { body: { data: [
    { name: 'hello', version: 3, auth_level: 'public', timeout_ms: 5000, description: 'Greets the world' },
    { name: 'secret', version: 1, auth_level: 'user', timeout_ms: 30000, description: null },
  ] } });
  const r = await fresh(['fn', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello/);
  assert.match(r.stdout, /v3/);
  assert.match(r.stdout, /public/);
  assert.match(r.stdout, /timeout=5000ms/);
  // The callable address is named under the list (cli#138).
  assert.match(r.stdout, /Endpoint: POST .*\/api\/p_TestProj\/fn\/<name>/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn logs <name> shows status + duration + error_message', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { status: 'success', duration_ms: 42, trigger_type: 'http', error_message: null, created_at: '2026-05-01T10:00:00Z' },
    { status: 'error',   duration_ms: 100, trigger_type: 'http', error_message: 'boom', created_at: '2026-05-02T10:00:00Z' },
  ] } });
  const r = await fresh(['fn', 'logs', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /success/);
  assert.match(r.stdout, /42ms/);
  assert.match(r.stdout, /error/);
  assert.match(r.stdout, /boom/); // catches the field-name bug we fixed earlier
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn logs <name> renders captured console output beneath each run (WT-363)', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/functions/hello/logs', { body: { data: [
    { status: 'success', duration_ms: 42, trigger_type: 'http', error_message: null, created_at: '2026-05-01T10:00:00Z',
      logs: [
        { level: 'log', message: 'hello from fn', timestamp: 1 },
        { level: 'error', message: 'kaboom inside', timestamp: 2 },
      ] },
  ] } });
  const r = await fresh(['fn', 'logs', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello from fn/);
  assert.match(r.stdout, /error: kaboom inside/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn call <name> posts and prints JSON', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/hello', { body: { data: { greeting: 'Hello!' } } });
  const r = await fresh(['fn', 'call', 'hello', '{"name":"world"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hello/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn call names the identity it calls as on stderr (stdout stays parseable)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/hello', { body: { data: { greeting: 'Hello!' } } });
  const r = await fresh(['fn', 'call', 'hello', '{}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Auth: calling as ec-test@914-6\.com/);
  assert.match(r.stderr, /--anon/); // points at the visitor path
  assert.doesNotMatch(r.stdout, /Auth:/); // identity note never pollutes stdout
});

test('gipity fn call --anon names the anonymous identity on stderr', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 'app-tok-123', expiresIn: 900 } } });
  mock.on('POST /api/p_TestProj/fn/hello', { body: { data: { greeting: 'Hello!' } } });
  const r = await fresh(['fn', 'call', 'hello', '{}', '--anon']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Auth: anonymous visitor/);
  assert.doesNotMatch(r.stdout, /Auth:/);
});

test('gipity fn call --field plucks one nested value (no node -e needed)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/review', { body: { data: { items: [{ short_guid: 'msg_123' }, { short_guid: 'msg_456' }] } } });
  const r = await fresh(['fn', 'call', 'review', '{"op":"queue"}', '--field', 'items.0.short_guid']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'msg_123');
});

test('gipity fn call --field exits 1 on a missing path', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/review', { body: { data: { items: [] } } });
  const r = await fresh(['fn', 'call', 'review', '{}', '--field', 'items.0.short_guid']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Field not found/);
});

test('gipity fn call --body is accepted as an alias for --data', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/hello', { body: { data: { greeting: 'Hello!' } } });
  const r = await fresh(['fn', 'call', 'hello', '--body', '{"name":"world"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hello/);
  const reqs = mock.requests();
  const post = reqs.find(q => q.method === 'POST' && q.url === '/api/p_TestProj/fn/hello');
  assert.ok(post, 'expected the call to POST');
  assert.deepEqual(post!.body, { name: 'world' });
});

test('gipity fn call --file base64-encodes a file into the JSON body (no manual base64 dance)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/fn/extract', { body: { data: { ok: true, text: 'hi' } } });
  const img = join(tmpdir(), `fn-file-${process.pid}.bin`);
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = await fresh(['fn', 'call', 'extract', '{"lang":"en"}', '--file', `image=@${img}`]);
  assert.equal(r.status, 0, r.stderr);
  const post = mock.requests().find(q => q.method === 'POST' && q.url === '/api/p_TestProj/fn/extract');
  assert.ok(post, 'expected the call to POST');
  assert.deepEqual(post!.body, { lang: 'en', image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
});

test('gipity fn call --anon calls the public path with an app token and no user auth (cli#122)', async () => {
  mock.reset();
  let mintBody: unknown;
  let callAuth: string | string[] | undefined;
  let callAppToken: string | string[] | undefined;
  mock.on('POST /api/token', (req) => {
    mintBody = req.body;
    return { body: { data: { token: 'app-tok-123', expiresIn: 900 } } };
  });
  mock.on('POST /api/p_TestProj/fn/submit-refund', (req) => {
    callAuth = req.headers['authorization'];
    callAppToken = req.headers['x-app-token'];
    return { body: { data: { ticket_code: 'RD-1', status: 'pending' } } };
  });
  const r = await fresh(['fn', 'call', 'submit-refund', '{"order":"1042"}', '--anon']);
  assert.equal(r.status, 0, r.stderr);
  // Unwrapped value, same shape as the authenticated call - no {data:{...}} envelope.
  assert.match(r.stdout, /ticket_code/);
  assert.doesNotMatch(r.stdout, /"data"/);
  assert.deepEqual(mintBody, { app: 'p_TestProj' });
  assert.equal(callAuth, undefined, 'anonymous call must not send Authorization');
  assert.equal(callAppToken, 'app-tok-123');
});

test('gipity fn call --anon still works when app-token minting fails (public fn path)', async () => {
  mock.reset();
  mock.on('POST /api/token', { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } } });
  mock.on('POST /api/p_TestProj/fn/hello', { body: { data: { greeting: 'Hi!' } } });
  const r = await fresh(['fn', 'call', 'hello', '{}', '--anon']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hi!/);
});

test('gipity fn call --anon surfaces the auth-gate error without a login hint', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 't', expiresIn: 900 } } });
  mock.on('POST /api/p_TestProj/fn/members-only', {
    status: 401,
    body: { error: { code: 'AUTH_REQUIRED', message: 'This function requires a signed-in user' } },
  });
  const r = await fresh(['fn', 'call', 'members-only', '{}', '--anon']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a signed-in user/);
  // A 401 on --anon is the function's real answer, not a broken CLI session.
  assert.doesNotMatch(r.stderr, /gipity login/);
});

test('an unknown option on fn call shows fn call help, not a sibling subcommand', async () => {
  mock.reset();
  const r = await fresh(['fn', 'call', 'hello', '--bogus']);
  assert.notEqual(r.status, 0);
  // The bug: commander shares one output config across sibling subcommands, so
  // the help block used to be the LAST-registered sibling (`fn delete`).
  assert.match(r.stderr, /Showing `gipity fn call --help`/);
  assert.doesNotMatch(r.stderr, /gipity fn delete --help/);
  assert.match(r.stderr, /unknown option '--bogus'/);
});

test('gipity fn delete <name> --yes DELETEs the function', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/functions/hello', { body: { data: { name: 'hello', deleted: true } } });
  const r = await fresh(['fn', 'delete', 'hello', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted function 'hello'/);
  const reqs = mock.requests();
  assert.ok(reqs.some(q => q.method === 'DELETE' && q.url === '/projects/p_TestProj/functions/hello'), 'expected a DELETE request');
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity fn rm <name> --yes is an alias for delete', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/functions/hello', { body: { data: { name: 'hello', deleted: true } } });
  const r = await fresh(['fn', 'rm', 'hello', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted function 'hello'/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;

before(async () => { mock = await startMockServer(); });
after(async () => { await mock.stop(); });

// Build a JWT with a real `exp` claim so decodeJwtExp returns a valid timestamp.
function makeJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
  return `${header}.${payload}.fakesignature`;
}

test('gipity login --email --code verifies and writes auth.json', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: {
    accessToken: makeJwt(),
    refreshToken: 'refresh-token',
    isNewUser: false,
  } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914'],
    { env: { HOME: home } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Logged in/);
  const auth = JSON.parse(readFileSync(join(home, '.gipity', 'auth.json'), 'utf-8'));
  assert.equal(auth.email, 'ec-test@914-6.com');
  assert.equal(auth.refreshToken, 'refresh-token');
});

test('gipity login --email (no code) requests a magic code and prints next-step hint', async () => {
  mock.reset();
  mock.on('POST /auth/login', { body: { data: { sent: true } } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com'],
    { env: { HOME: home } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Check your email/);
});

// bug cli#S2: the server already knows isNewUser at login time; the CLI must
// surface it instead of silently landing the session in a fresh, empty account.
test('gipity login --email --code warns when a new account is created for a directory linked to an existing project', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: { accessToken: makeJwt(), refreshToken: 'refresh-token', isNewUser: true } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const dir = makeProjectDir({ projectSlug: 'my-app', accountSlug: 'acct-original' });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NEW, empty account/);
  assert.match(r.stdout, /my-app/);
  assert.match(r.stdout, /acct-original/);
});

test('gipity login --email --code does not warn when the account already existed', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: { accessToken: makeJwt(), refreshToken: 'refresh-token', isNewUser: false } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const dir = makeProjectDir();
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /NEW, empty account/);
});

test('gipity login --email --code does not warn on a genuine first-time signup (no linked project, no prior session)', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: { accessToken: makeJwt(), refreshToken: 'refresh-token', isNewUser: true } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const dir = mkdtempSync(join(tmpdir(), 'gipity-nolink-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /NEW, empty account/);
});

test('gipity login --email --code warns on a new account when this machine already held a session for the same email', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: { accessToken: makeJwt(), refreshToken: 'refresh-token', isNewUser: true } });
  const home = makeAuthedHome({ email: 'ec-test@914-6.com' });
  const dir = mkdtempSync(join(tmpdir(), 'gipity-nolink-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NEW, empty account/);
});

test('gipity login --email (no code) warns before the code is entered when it would create a new account for a linked project', async () => {
  mock.reset();
  mock.on('POST /auth/login', { body: { message: 'Check your email for a login code', isNewUser: true } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const dir = makeProjectDir({ projectSlug: 'my-app' });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /will CREATE a new one/);
  assert.match(r.stdout, /my-app/);
});

test('gipity login --email --code --json prints one JSON result and sends the new-account warning to stderr', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: { accessToken: makeJwt(), refreshToken: 'refresh-token', isNewUser: true } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const dir = makeProjectDir({ projectSlug: 'my-app', accountSlug: 'acct-original' });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914', '--json'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.loggedIn, true);
  assert.equal(out.email, 'ec-test@914-6.com');
  assert.equal(out.newAccount, true);
  assert.ok(!Number.isNaN(Date.parse(out.expiresAt)), 'expiresAt is an ISO date');
  assert.equal(out.queuedBugReportsDelivered, 0);
  assert.match(r.stderr, /NEW, empty account/);
  const auth = JSON.parse(readFileSync(join(home, '.gipity', 'auth.json'), 'utf-8'));
  assert.equal(auth.email, 'ec-test@914-6.com');
});

test('gipity login --email --json reports the sent code and the next command', async () => {
  mock.reset();
  mock.on('POST /auth/login', { body: { isNewUser: false } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--json'],
    { env: { HOME: home } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    codeSent: true,
    email: 'ec-test@914-6.com',
    newAccount: false,
    next: 'gipity login --email ec-test@914-6.com --code <code>',
  });
});

// An account that requires a passkey: a correct code returns a sign-in link and
// a poll token instead of tokens. The CLI must print the link, poll until the
// browser step is done, and only then save the session (device flow).
test('gipity login --email --code on a passkey-required account prints the link, polls, then saves the session', async () => {
  mock.reset();
  const verificationUrl = 'https://a.gipity.ai/auth/passkey?step=step-token-for-test';
  const pollToken = 'p'.repeat(43);
  mock.on('POST /auth/verify', { body: { passkeyRequired: true, verificationUrl, pollToken, interval: 0, expiresIn: 30 } });
  let polls = 0;
  mock.on('POST /auth/passkey/poll', (req) => {
    assert.deepEqual(req.body, { pollToken });
    polls++;
    return polls < 3
      ? { body: { status: 'pending', interval: 0 } }
      : { body: { status: 'complete', accessToken: makeJwt(), refreshToken: 'passkey-refresh', email: 'ec-test@914-6.com' } };
  });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '123456', '--json'],
    { env: { HOME: home } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /requires a passkey/);
  assert.ok(r.stderr.includes(verificationUrl), 'the sign-in link is printed');
  assert.equal(polls, 3);
  const out = JSON.parse(r.stdout);
  assert.equal(out.loggedIn, true);
  assert.equal(out.passkey, true);
  const verifyReq = mock.requests().find((q) => q.url === '/auth/verify');
  assert.deepEqual(verifyReq?.body, { email: 'ec-test@914-6.com', code: '123456', client: 'cli' });
  const auth = JSON.parse(readFileSync(join(home, '.gipity', 'auth.json'), 'utf-8'));
  assert.equal(auth.refreshToken, 'passkey-refresh');
});

test('gipity login on a passkey-required account fails cleanly when the sign-in expires, saving nothing', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: {
    passkeyRequired: true, verificationUrl: 'https://a.gipity.ai/auth/passkey?step=s', pollToken: 'q'.repeat(43), interval: 0, expiresIn: 30,
  } });
  mock.on('POST /auth/passkey/poll', { status: 410, body: { error: { code: 'EXPIRED', message: 'This sign-in has expired.' } } });
  const home = mkdtempSync(join(tmpdir(), 'gipity-login-'));
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '123456'],
    { env: { HOME: home } },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expired or was cancelled/);
  assert.equal(existsSync(join(home, '.gipity', 'auth.json')), false);
});

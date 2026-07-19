import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
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

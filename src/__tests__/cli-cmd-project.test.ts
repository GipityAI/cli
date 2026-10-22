import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

let mock: MockServer;
let home: string;

const PROJ_A = { short_guid: 'p_ProjA00n0', name: 'Alpha', slug: 'alpha', description: null, is_default: 0, auth_mode: 'gipity', unique_player_names: false, created_at: '2026-01-01T00:00:00Z' };
const PROJ_B = { short_guid: 'p_ProjB00n0', name: 'Beta',  slug: 'beta',  description: 'Beta project', is_default: 0, auth_mode: 'app', unique_player_names: true, created_at: '2026-02-01T00:00:00Z' };

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => { await mock.stop(); });

/** Each test gets a fresh project dir so config writes don't bleed between tests. */
function inProject(args: string[], projectGuid = PROJ_A.short_guid, projectSlug = PROJ_A.slug) {
  const projectDir = makeProjectDir({ apiBase: mock.apiBase, projectGuid, projectSlug });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: projectDir });
}

test('gipity project (bare) lists projects', async () => {
  mock.reset();
  mock.on('GET /projects', { body: { data: [PROJ_A, PROJ_B], totalCount: 2 } });
  const r = await inProject(['project']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha/);
  assert.match(r.stdout, /beta/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity project <name> switches to that project', async () => {
  mock.reset();
  mock.on('GET /projects', { body: { data: [PROJ_A, PROJ_B], totalCount: 2 } });
  const r = await inProject(['project', 'beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Switched to Beta/);
});

test('gipity project rename <name> PUTs the current project', async () => {
  mock.reset();
  mock.on('PUT /projects/p_ProjA00n0', { body: { data: { ...PROJ_A, name: 'AlphaRenamed' } } });
  const r = await inProject(['project', 'rename', 'AlphaRenamed']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed.*AlphaRenamed/);
});

test('gipity project rename --project <target> resolves and PUTs that project', async () => {
  mock.reset();
  mock.on('GET /projects', { body: { data: [PROJ_A, PROJ_B], totalCount: 2 } });
  mock.on('PUT /projects/p_ProjB00n0', { body: { data: { ...PROJ_B, name: 'BetaRenamed' } } });
  const r = await inProject(['project', 'rename', '--project', 'beta', 'BetaRenamed']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed.*BetaRenamed/);
});

test('gipity project info shows fields from /projects/:guid', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0', { body: { data: PROJ_A } });
  const r = await inProject(['project', 'info']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Name:\s+Alpha/);
  assert.match(r.stdout, /Slug:\s+alpha/);
  assert.match(r.stdout, /Sign-in:\s+gipity/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

const AUTH_STATUS = {
  auth_mode: 'gipity', unique_player_names: false, email_code: true,
  providers: [
    { provider: 'google', credentials: 'shared', available: true, redirect_uri: 'https://a.gipity.ai/api/p_ProjA00n0/auth/google/callback', note: 'Consent screen shows "Gipity Apps"' },
    { provider: 'apple', credentials: null, available: false, redirect_uri: 'https://a.gipity.ai/api/p_ProjA00n0/auth/apple/callback', note: 'Needs your own credentials' },
    { provider: 'discord', credentials: 'own', available: true, redirect_uri: 'https://a.gipity.ai/api/p_ProjA00n0/auth/discord/callback', note: null },
  ],
  warnings: ['This app has a custom domain but Google sign-in still uses Gipity\'s shared credentials.'],
};

test('gipity project auth shows the mode, sets a valid one, and refuses junk', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0/auth', { body: { data: AUTH_STATUS } });
  const shown = await inProject(['project', 'auth']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Sign-in: gipity/);

  mock.on('PUT /projects/p_ProjA00n0', { body: { data: { success: true } } });
  const set = await inProject(['project', 'auth', 'app']);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /Sign-in set to "app"/);
  const put = mock.requests().find(c => c.method === 'PUT' && c.url === '/projects/p_ProjA00n0');
  assert.deepEqual(put?.body, { auth_mode: 'app' });

  const bad = await inProject(['project', 'auth', 'steam']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown mode "steam"/);
});

test('gipity project auth --unique-names shows, sets, reports shared names, and refuses junk', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0/auth', { body: { data: AUTH_STATUS } });
  const shown = await inProject(['project', 'auth']);
  assert.match(shown.stdout, /Unique names: off/);

  mock.on('PUT /projects/p_ProjA00n0', { body: { data: { success: true, players_sharing_names: 3 } } });
  const on = await inProject(['project', 'auth', '--unique-names', 'on']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /Unique names on/);
  assert.match(on.stdout, /3 existing players share a name/);
  const put = mock.requests().find(c => c.method === 'PUT' && c.url === '/projects/p_ProjA00n0');
  assert.deepEqual(put?.body, { unique_player_names: true });

  mock.reset();
  mock.on('PUT /projects/p_ProjA00n0', { body: { data: { success: true, players_sharing_names: 0 } } });
  const both = await inProject(['project', 'auth', 'app', '--unique-names', 'off', '--json']);
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(JSON.parse(both.stdout), { auth_mode: 'app', unique_player_names: false, players_sharing_names: 0 });
  const put2 = mock.requests().find(c => c.method === 'PUT');
  assert.deepEqual(put2?.body, { auth_mode: 'app', unique_player_names: false });

  const bad = await inProject(['project', 'auth', '--unique-names', 'yes']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--unique-names takes "on" or "off"/);
});

test('gipity project auth status lists email codes, providers and warnings; --json is the data', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0/auth', { body: { data: AUTH_STATUS } });
  const r = await inProject(['project', 'auth']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Email codes: on/);
  assert.match(r.stdout, /Google\s+shared \(Gipity\)\s+Consent screen/);
  assert.match(r.stdout, /Apple\s+not set/);
  assert.match(r.stdout, /Discord\s+own/);
  assert.match(r.stdout, /custom domain but Google sign-in/);
  assert.doesNotMatch(r.stdout, /undefined|null/);

  const j = await inProject(['project', 'auth', '--json']);
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout), AUTH_STATUS);
});

test('gipity project auth provider <name> shows the redirect URI and setup steps', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0/auth', { body: { data: AUTH_STATUS } });
  const r = await inProject(['project', 'auth', 'provider', 'google']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Redirect URI: https:\/\/a\.gipity\.ai\/api\/p_ProjA00n0\/auth\/google\/callback/);
  assert.match(r.stdout, /1\. Google Cloud console/);
  assert.match(r.stdout, /keeps every existing user/);

  const j = await inProject(['project', 'auth', 'provider', 'apple', '--json']);
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).provider, 'apple');

  const bad = await inProject(['project', 'auth', 'provider', 'facebook']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown provider "facebook"/);
});

test('gipity project auth provider sets own credentials and validates flags per provider', async () => {
  mock.reset();
  mock.on('PUT /projects/p_ProjA00n0/auth/providers/google', { body: { data: { provider: 'google', credentials: 'own' } } });
  const r = await inProject(['project', 'auth', 'provider', 'google', '--client-id', 'cid', '--client-secret', 'sec']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Google sign-in now uses your own credentials/);
  const put = mock.requests().find(c => c.method === 'PUT');
  assert.deepEqual(put?.body, { client_id: 'cid', client_secret: 'sec' });

  mock.reset();
  const missing = await inProject(['project', 'auth', 'provider', 'discord', '--client-id', 'cid']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Discord needs --client-secret/);

  const appleMissing = await inProject(['project', 'auth', 'provider', 'apple', '--client-id', 'com.x.web', '--team-id', 'T1']);
  assert.notEqual(appleMissing.status, 0);
  assert.match(appleMissing.stderr, /Apple needs --key-id, --private-key-file/);

  const appleOnly = await inProject(['project', 'auth', 'provider', 'google', '--client-id', 'a', '--client-secret', 'b', '--team-id', 'T1']);
  assert.notEqual(appleOnly.status, 0);
  assert.match(appleOnly.stderr, /for Apple only/);

  const noFile = await inProject(['project', 'auth', 'provider', 'apple', '--client-id', 'c', '--team-id', 't', '--key-id', 'k', '--private-key-file', '/nonexistent/AuthKey.p8']);
  assert.notEqual(noFile.status, 0);
  assert.match(noFile.stderr, /Cannot read \/nonexistent\/AuthKey\.p8/);
  assert.equal(mock.requests().filter(c => c.method === 'PUT').length, 0);
});

test('gipity project auth provider apple reads the .p8 private key file', async () => {
  mock.reset();
  mock.on('PUT /projects/p_ProjA00n0/auth/providers/apple', { body: { data: { provider: 'apple', credentials: 'own' } } });
  const key = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMG\n-----END PRIVATE KEY-----\n';
  const keyFile = join(home, 'AuthKey_ABC123.p8');
  writeFileSync(keyFile, key);
  const r = await inProject(['project', 'auth', 'provider', 'apple', '--client-id', 'com.x.web', '--team-id', 'TEAM1', '--key-id', 'ABC123', '--private-key-file', keyFile, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { provider: 'apple', credentials: 'own' });
  const put = mock.requests().find(c => c.method === 'PUT');
  assert.deepEqual(put?.body, { client_id: 'com.x.web', team_id: 'TEAM1', key_id: 'ABC123', private_key: key });
});

test('gipity project auth provider --shared goes back to shared credentials', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_ProjA00n0/auth/providers/google', { body: { data: { provider: 'google', credentials: 'shared' } } });
  mock.on('DELETE /projects/p_ProjA00n0/auth/providers/apple', { body: { data: { provider: 'apple', credentials: null } } });
  const g = await inProject(['project', 'auth', 'provider', 'google', '--shared']);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /shared credentials/);
  const a = await inProject(['project', 'auth', 'provider', 'apple', '--shared']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Apple sign-in is off/);
  const both = await inProject(['project', 'auth', 'provider', 'google', '--shared', '--client-id', 'x']);
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /cannot be combined/);
});

const USER_1 = { guid: 'u_One', display_name: 'Ann, "The" Tester', email: 'ann@example.com', providers: ['google', 'email'], created_at: '2026-10-01T10:00:00Z', last_login_at: '2026-10-20T10:00:00Z' };
const USER_2 = { guid: 'u_Two', display_name: 'Bob', email: null, providers: ['steam'], created_at: '2026-10-02T10:00:00Z', last_login_at: null };
const USER_3 = { guid: 'u_Three', display_name: 'Line\nBreak', email: 'c@example.com', providers: [], created_at: '2026-10-03T10:00:00Z', last_login_at: null };

test('gipity project users lists users with a count footer and passes search/limit', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0/app-users', { body: { data: { users: [USER_1, USER_2], next_cursor: 'c2', total: 3 } } });
  const r = await inProject(['project', 'users', '--search', 'a b', '--limit', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /u_One\s+Ann, "The" Tester\s+ann@example\.com\s+google, email\s+2026-10-01\s+2026-10-20/);
  assert.match(r.stdout, /u_Two\s+Bob\s+-\s+steam/);
  assert.match(r.stdout, /2 of 3 users/);
  assert.match(r.stdout, /gipity project users export/);
  const req = mock.requests().find(c => c.method === 'GET');
  assert.equal(req?.url, '/projects/p_ProjA00n0/app-users?search=a+b&limit=2');

  const list = await inProject(['project', 'users', 'list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).total, 3);

  const bad = await inProject(['project', 'users', '--limit', '900']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--limit takes a whole number from 1 to 500/);
});

test('gipity project users export pages through cursors and quotes CSV', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0/app-users', (req) => {
    const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
    if (!cursor) return { body: { data: { users: [USER_1], next_cursor: 'c2', total: 3 } } };
    if (cursor === 'c2') return { body: { data: { users: [USER_2], next_cursor: 'c3', total: 3 } } };
    return { body: { data: { users: [USER_3], next_cursor: null, total: 3 } } };
  });
  const r = await inProject(['project', 'users', 'export']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), [
    'guid,display_name,email,providers,created_at,last_login_at',
    'u_One,"Ann, ""The"" Tester",ann@example.com,google;email,2026-10-01T10:00:00Z,2026-10-20T10:00:00Z',
    'u_Two,Bob,,steam,2026-10-02T10:00:00Z,',
    'u_Three,"Line\nBreak",c@example.com,,2026-10-03T10:00:00Z,',
  ].join('\n'));
  const gets = mock.requests().filter(c => c.method === 'GET').map(c => c.url);
  assert.deepEqual(gets, [
    '/projects/p_ProjA00n0/app-users?limit=500',
    '/projects/p_ProjA00n0/app-users?limit=500&cursor=c2',
    '/projects/p_ProjA00n0/app-users?limit=500&cursor=c3',
  ]);

  const out = join(home, 'users.json');
  const j = await inProject(['project', 'users', 'export', '--format', 'json', '-o', out]);
  assert.equal(j.status, 0, j.stderr);
  assert.match(j.stdout, /Exported 3 users to/);
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf-8')).map((u: { guid: string }) => u.guid), ['u_One', 'u_Two', 'u_Three']);
});

test('gipity project users delete refuses non-interactive without -y, deletes with it', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_ProjA00n0/app-users/u_One', { body: { data: { deleted: true } } });
  const refused = await inProject(['project', 'users', 'delete', 'u_One']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Confirmation required.*--yes/s);
  assert.equal(mock.requests().filter(c => c.method === 'DELETE').length, 0);

  const ok = await inProject(['project', 'users', 'delete', 'u_One', '-y']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Deleted user u_One/);

  mock.reset();
  mock.on('DELETE /projects/p_ProjA00n0/app-users/u_Two', { status: 502, body: { error: { code: 'PLAYER_CLEANUP_FAILED', message: 'The leaderboard user_deleted hook failed' } } });
  const failed = await inProject(['project', 'users', 'delete', 'u_Two', '--yes']);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /user_deleted hook failed/);
});

test('gipity project users signout revokes sessions and prints the count', async () => {
  mock.reset();
  mock.on('POST /projects/p_ProjA00n0/app-users/u_One/signout', { body: { data: { signed_out_sessions: 2 } } });
  const r = await inProject(['project', 'users', 'signout', 'u_One']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 sessions ended/);
});

test('gipity project delete --yes calls DELETE', async () => {
  mock.reset();
  mock.on('GET /projects', { body: { data: [PROJ_A, PROJ_B], totalCount: 2 } });
  mock.on('DELETE /projects/p_ProjB00n0', { body: { data: { deleted: true } } });
  const r = await inProject(['--yes', 'project', 'delete', 'beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted "Beta"/);
});

// ── --json purity ──────────────────────────────────────────────────────
// `project create --json` and `load --json` used to print setup notices
// ("Wrote Codex ... hooks", "Resolved template vars in N files") on stdout
// ahead of the JSON, so `JSON.parse(stdout)` failed. Notices go to stderr.

/** A HOME whose projects root already holds `<slug>/index.html` with a
 *  placeholder (forces the template-vars notice) plus a fake `codex` binary on
 *  PATH (forces the Codex hooks notice). */
function jsonPurityEnv(slug: string): { env: Record<string, string> } {
  const h = makeAuthedHome();
  const projects = join(h, 'GipityProjects');
  mkdirSync(join(h, '.gipity'), { recursive: true });
  writeFileSync(join(h, '.gipity', 'settings.json'), JSON.stringify({ projectsDir: projects }));
  mkdirSync(join(projects, slug), { recursive: true });
  writeFileSync(join(projects, slug, 'index.html'), '<title>{{TITLE}}</title>');
  const bin = join(h, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'codex'), 0o755);
  return { env: { HOME: h, PATH: `${bin}:${process.env['PATH'] ?? ''}` } };
}

function parseStdoutJson(stdout: string): Record<string, unknown> {
  try { return JSON.parse(stdout); } catch { assert.fail(`stdout is not pure JSON:\n${stdout}`); }
}

test('gipity project create --json prints only JSON on stdout', { skip: process.platform === 'win32' }, async () => {
  mock.reset();
  mock.on('POST /projects', { body: { data: { ...PROJ_A, slug: 'jsonpure', name: 'JsonPure' } } });
  mock.on('GET /users/me', { body: { data: { accountSlug: 'tester' } } });
  const { env } = jsonPurityEnv('jsonpure');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'project', 'create', 'JsonPure', '--json'], { env });
  assert.equal(r.status, 0, r.stderr);
  const parsed = parseStdoutJson(r.stdout);
  assert.equal(parsed.created, 'jsonpure');
  assert.match(r.stderr, /Resolved template vars/);
  assert.match(r.stderr, /Codex/);
});

test('gipity load --json prints only JSON on stdout', { skip: process.platform === 'win32' }, async () => {
  mock.reset();
  mock.on('POST /projects/import', { status: 201, body: { data: {
    project: { short_guid: PROJ_B.short_guid, name: 'Loaded', slug: 'loaded' },
    written: 1, manifest: {}, meta: null,
  } } });
  mock.on('GET /users/me', { body: { data: { accountSlug: 'tester' } } });
  const { env } = jsonPurityEnv('loaded');
  const bundle = join(env.HOME, 'app.gip');
  writeFileSync(bundle, 'PK');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'load', bundle, '--json'], { env });
  assert.equal(r.status, 0, r.stderr);
  const parsed = parseStdoutJson(r.stdout);
  assert.equal(parsed.created, 'loaded');
  assert.match(r.stderr, /Resolved template vars/);
});

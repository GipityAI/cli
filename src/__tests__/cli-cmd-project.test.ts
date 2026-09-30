import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

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

test('gipity project auth shows the mode, sets a valid one, and refuses junk', async () => {
  mock.reset();
  mock.on('GET /projects/p_ProjA00n0', { body: { data: PROJ_A } });
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
  mock.on('GET /projects/p_ProjA00n0', { body: { data: PROJ_A } });
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

test('gipity project delete --yes calls DELETE', async () => {
  mock.reset();
  mock.on('GET /projects', { body: { data: [PROJ_A, PROJ_B], totalCount: 2 } });
  mock.on('DELETE /projects/p_ProjB00n0', { body: { data: { deleted: true } } });
  const r = await inProject(['--yes', 'project', 'delete', 'beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted "Beta"/);
});

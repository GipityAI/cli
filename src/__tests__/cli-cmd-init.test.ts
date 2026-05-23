/**
 * `gipity init` - the explicit "make this directory a project" verb.
 *
 * Unlike walk-up commands, `init` resolves only cwd: it must refuse $HOME and
 * system roots, re-run setup when cwd is already a project, warn before
 * creating a project nested inside an existing one, and otherwise adopt cwd.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function freshDir(prefix = 'gipity-cli-init-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfig(dir: string, slug: string): void {
  writeFileSync(join(dir, '.gipity.json'), JSON.stringify({
    projectGuid: `p_${slug}`,
    projectSlug: slug,
    accountSlug: 'acct',
    agentGuid: '',
    conversationGuid: null,
    apiBase: mock.apiBase,
    ignore: [],
  }));
}

test('gipity init refuses $HOME as a project root', async () => {
  mock.reset();
  const r = await runCliAsync(['--api-base', mock.apiBase, 'init'], { env: { HOME: home }, cwd: home });
  assert.notEqual(r.status, 0, 'should exit non-zero');
  assert.match(r.stderr + r.stdout, /can't be used as a Gipity project root/);
  assert.equal(existsSync(join(home, '.gipity.json')), false, 'must not create a config in $HOME');
});

test('gipity init in an already-linked directory just re-runs setup', async () => {
  mock.reset();
  const dir = freshDir();
  writeConfig(dir, 'already-here');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'init'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already linked/);
  assert.match(r.stdout, /already-here/);
});

test('gipity init warns and aborts when it would nest inside an existing project', async () => {
  mock.reset();
  const parent = freshDir('gipity-cli-init-parent-');
  writeConfig(parent, 'parent-proj');
  const sub = join(parent, 'child');
  mkdirSync(sub);

  // No --yes: the nesting confirmation is declined in the non-TTY child.
  const r = await runCliAsync(['--api-base', mock.apiBase, 'init'], { env: { HOME: home }, cwd: sub });
  assert.notEqual(r.status, 0, 'should abort without confirmation');
  assert.match(r.stdout, /already a Gipity project/);
  assert.match(r.stdout, /Aborted/);
  assert.equal(existsSync(join(sub, '.gipity.json')), false, 'an aborted init must not write a config');
});

test('gipity init creates a new project in an empty directory', async () => {
  mock.reset();
  mock.on('GET /users/me', { body: { data: { accountSlug: 'test-acct' } } });
  mock.on('GET /projects', { body: { data: [], totalCount: 0 } });
  mock.on('POST /projects', { body: { data: { short_guid: 'p_NewInit000', name: 'my-app', slug: 'my-app' } } });
  mock.on('GET /projects/p_NewInit000/agents', { body: { data: [] } });
  mock.on('GET /projects/p_NewInit000/files/tree', { body: { data: [] } });

  const dir = freshDir();
  const r = await runCliAsync(['--api-base', mock.apiBase, 'init', 'my-app'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created project "my-app"/);
  assert.ok(existsSync(join(dir, '.gipity.json')), 'init should write .gipity.json into cwd');
});

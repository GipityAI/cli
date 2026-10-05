import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity add web-simple posts and prints files', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/add', { body: { data: {
    kind: 'template',
    files: ['index.html', 'css/styles.css', 'js/main.js'],
    title: 'my-app',
    type: 'web-simple',
  } } });
  // sync() reads the remote tree post-add; serve an empty list so sync is a no-op.
  mock.on('GET /projects/p_TestProj/files/tree', { body: { data: [] } });
  const r = await fresh(['add', 'web-simple', '--title', 'my-app']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Scaffolded "my-app"/);
  assert.match(r.stdout, /index\.html/);
  assert.match(r.stdout, /styles\.css/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity add scaffolds compactly and points at the files that carry the conventions', async () => {
  mock.reset();
  const files = [
    'README.md', 'docs/README.md', 'gipity.yaml', 'src/css/gipity-theme.css', 'src/css/styles.css',
    'src/index.html', 'src/js/config.js', 'src/js/main.js', 'src/js/settings.js',
  ];
  mock.on('POST /projects/p_TestProj/add', { body: { data: {
    kind: 'template', files, title: 'my-app', type: 'web-fullstack',
  } } });
  mock.on('GET /projects/p_TestProj/files/tree', { body: { data: [] } });
  const r = await fresh(['add', 'web-fullstack']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Start here.*README\.md.*gipity\.yaml.*src\/index\.html/);
  // Every path still reported, but packed - not one line each, and the kit
  // catalog no longer spends a line per kit.
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.length < 12, `install report too long:\n${r.stdout}`);
  for (const f of files) assert.ok(r.stdout.includes(f), `missing ${f}`);
  assert.match(r.stdout, /realtime/);  // kits still discoverable
});

test('gipity add realtime installs a kit', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/add', { body: { data: {
    kind: 'kit',
    kit: 'realtime',
    files: ['src/packages/realtime/index.js'],
    notes: ['Import it: ...'],
  } } });
  mock.on('GET /projects/p_TestProj/files/tree', { body: { data: [] } });
  const r = await fresh(['add', 'realtime']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Added the "realtime" kit/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity add --list groups the catalog as templates, apps and kits', async () => {
  mock.reset();
  const text = await fresh(['add', '--list']);
  assert.equal(text.status, 0, text.stderr);
  const ti = text.stdout.indexOf('Templates'), ai = text.stdout.indexOf('Apps'), ki = text.stdout.indexOf('Kits');
  assert.ok(ti >= 0 && ai > ti && ki > ai, text.stdout);
  assert.match(text.stdout.slice(ti, ai), /web-simple/);
  assert.match(text.stdout.slice(ai, ki), /3d-world/);
  assert.doesNotMatch(text.stdout, /outreach-agent/); // incomplete: installable by key, not listed

  const json = await fresh(['add', '--list', '--json']);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(out), ['templates', 'apps', 'kits']);
  assert.ok(out.templates.some((e: { key: string }) => e.key === 'api'));
  assert.ok(out.apps.some((e: { key: string }) => e.key === 'paid-app'));
  assert.ok(out.kits.some((e: { key: string }) => e.key === 'realtime'));
  assert.equal(mock.requests().length, 0);
});

test('gipity add syncs local edits BEFORE the server-side install, so the install merges into them', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/add', { body: { data: { kind: 'kit', files: ['src/packages/realtime/index.js'], kit: 'realtime', notes: [] } } });
  mock.on('GET /projects/p_TestProj/files/tree', { body: { data: [] } });
  const d = makeProjectDir({ apiBase: mock.apiBase });
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'index.html'), '<html><!-- my unsynced edit --></html>');
  await runCliAsync(['--api-base', mock.apiBase, 'add', 'realtime'], { env: { HOME: home }, cwd: d });
  const order = mock.requests().map((q) => `${q.method} ${q.url.split('?')[0]}`);
  const firstSync = order.findIndex((r) => r.includes('/files'));
  const install = order.indexOf('POST /projects/p_TestProj/add');
  assert.ok(install > 0, `the install ran (${order.join(', ')})`);
  assert.ok(firstSync >= 0 && firstSync < install, `local changes were synced before the install: ${order.join(', ')}`);
});


test('gipity add name=<key> names the bare positional instead of an unknown-template error', async () => {
  mock.reset();
  const r = await fresh(['add', 'name=3d-engine', '--title', 'Blocks']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /"name=3d-engine" is a key=value pair.*gipity add 3d-engine/);
  assert.equal(mock.requests().filter((q) => q.url.endsWith('/add')).length, 0, 'nothing posted');
});

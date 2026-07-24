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

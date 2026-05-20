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

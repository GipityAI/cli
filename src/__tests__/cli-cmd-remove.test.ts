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

test('gipity remove <kit> --yes POSTs to /remove and prints removed items', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/remove', { body: { data: {
    kind: 'kit',
    kit: 'records',
    removed: ['functions/record-write/index.js', 'src/packages/records/ (5 files)'],
    notes: ['Database tables created by this kit\'s migrations were left in place (no data loss).'],
  } } });
  // sync() reads the remote tree post-remove; serve an empty list so sync is a no-op.
  mock.on('GET /projects/p_TestProj/files/tree', { body: { data: [] } });
  const r = await fresh(['remove', 'records', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed the "records" kit/);
  assert.match(r.stdout, /record-write/);
  assert.match(r.stdout, /left in place/);
});

test('gipity remove surfaces a dependents error from the server', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/remove', {
    status: 409,
    body: { error: { code: 'KIT_HAS_DEPENDENTS', message: "Cannot remove 'records': the 'views' kit requires it. Remove it first." } },
  });
  const r = await fresh(['remove', 'records', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /views.*requires it/);
});

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

test('gipity realtime room list prints rooms', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/realtime-rooms', { body: { data: [
    { name: 'lobby', room_type: 'state', auth_level: 'public', max_clients: 50 },
  ] } });
  const r = await fresh(['realtime', 'room', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lobby/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity realtime room create posts and confirms', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/realtime-rooms', { body: { data: {
    name: 'arena', room_type: 'state', auth_level: 'public', max_clients: 50,
  } } });
  const r = await fresh(['realtime', 'room', 'create', 'arena']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created room 'arena'/);
});

test('gipity realtime room info shows details', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/realtime-rooms/arena', { body: { data: {
    room: { name: 'arena', room_type: 'state', auth_level: 'public', max_clients: 50 },
    live: { instances: 1, clients: 3 },
  } } });
  const r = await fresh(['realtime', 'room', 'info', 'arena']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /arena/);
  assert.match(r.stdout, /3 client/);
});

test('gipity realtime room delete confirms', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/realtime-rooms/arena', { body: { data: { success: true } } });
  const r = await fresh(['realtime', 'room', 'delete', 'arena']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted room 'arena'/);
});

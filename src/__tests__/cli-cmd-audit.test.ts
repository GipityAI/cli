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

test('gipity audit list shows events with timestamp + type', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/audit', { body: { data: [
    { event_type: 'record.create', action: 'create', entity_type: 'incidents', entity_id: '42', created_at: '2026-05-01T10:00:00Z' },
    { event_type: 'record.delete', action: 'delete', entity_type: 'incidents', entity_id: '7',  created_at: '2026-05-02T10:00:00Z' },
  ] } });
  const r = await fresh(['audit', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /record\.create/);
  assert.match(r.stdout, /incidents:42/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity audit count prints "N events"', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/audit/count', { body: { data: { count: 137 } } });
  const r = await fresh(['audit', 'count']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /137 events/);
});

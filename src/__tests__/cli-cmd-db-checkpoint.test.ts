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

const DBS = { body: { data: [{ friendlyName: 'app', internalName: 'ecu_app', projectGuid: 'p_test' }] } };

/** Serve the one checkpoint endpoint and record what the CLI asked it to do. */
function stubCheckpoint(
  calls: Array<{ database: string; action: string; keep?: boolean }>,
  reply: (action: string) => { status?: number; body: unknown },
) {
  mock.on('POST *', (req: any) => {
    const b = (req.body ?? {}) as { database: string; action: string; keep?: boolean };
    calls.push(b);
    return reply(b.action);
  });
}

test('db checkpoint asks the server for a snapshot - the CLI never writes checkpoint DDL', async () => {
  mock.reset();
  mock.on('GET *', DBS);
  const calls: Array<{ database: string; action: string }> = [];
  stubCheckpoint(calls, () => ({ body: { data: { database: 'app', tables: ['drafts', 'posts'], rows: 4 } } }));

  const r = await fresh(['db', 'checkpoint']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls, [{ database: 'app', action: 'create' }]);
  // The snapshot lives server-side in a hidden schema; no SQL leaves the CLI.
  assert.ok(!mock.requests().some(q => q.url.includes('/db/query')), 'CLI must not run checkpoint SQL itself');
  assert.match(r.stdout, /Checkpointed 2 table\(s\), 4 row\(s\)/);
  assert.match(r.stdout, /gipity db restore/);
});

test('db checkpoint --drop discards the snapshot and keeps current data', async () => {
  mock.reset();
  mock.on('GET *', DBS);
  const calls: Array<{ database: string; action: string }> = [];
  stubCheckpoint(calls, () => ({ body: { data: { database: 'app', tables: ['drafts'], rows: 0 } } }));

  const r = await fresh(['db', 'checkpoint', '--drop']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls, [{ database: 'app', action: 'drop' }]);
  assert.match(r.stdout, /Discarded the checkpoint of 1 table\(s\)/);
});

test('db restore rolls back through the server endpoint', async () => {
  mock.reset();
  mock.on('GET *', DBS);
  const calls: Array<{ database: string; action: string; keep?: boolean }> = [];
  stubCheckpoint(calls, () => ({ body: { data: { database: 'app', tables: ['drafts'], rows: 3 } } }));

  const r = await fresh(['db', 'restore']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls, [{ database: 'app', action: 'restore' }]);
  assert.match(r.stdout, /Restored 1 table\(s\) to the checkpoint \(3 row\(s\)\)/);
});

test('db restore --keep leaves the checkpoint in place for a repeat run', async () => {
  mock.reset();
  mock.on('GET *', DBS);
  const calls: Array<{ database: string; action: string; keep?: boolean }> = [];
  stubCheckpoint(calls, () => ({ body: { data: { database: 'app', tables: ['drafts'], rows: 1 } } }));

  const r = await fresh(['db', 'restore', '--keep']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls, [{ database: 'app', action: 'restore', keep: true }]);
  assert.match(r.stdout, /Checkpoint kept/);
});

test('db restore without a checkpoint says how to take one instead of failing opaquely', async () => {
  mock.reset();
  mock.on('GET *', DBS);
  const calls: Array<{ database: string; action: string }> = [];
  stubCheckpoint(calls, () => ({
    status: 400,
    body: {
      error: {
        code: 'CHECKPOINT_ERROR',
        message: "No checkpoint for database 'app'. Take one BEFORE the run that writes: gipity db checkpoint",
      },
    },
  }));

  const r = await fresh(['db', 'restore']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /No checkpoint/);
  assert.match(r.stdout + r.stderr, /gipity db checkpoint/);
});

test('page eval --restore-db is discoverable from the write-path angle', async () => {
  mock.reset();
  const r = await fresh(['page', 'eval', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--restore-db/);
  assert.match(r.stdout, /gipity db\s+checkpoint/);
});

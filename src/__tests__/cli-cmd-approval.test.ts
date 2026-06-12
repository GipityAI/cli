import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function run(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

test('gipity approval list shows pending approvals with status', async () => {
  mock.reset();
  mock.on('GET /approvals', { body: { data: [
    { guid: 'ap_Approv001', title: 'Deploy to prod?', status: 'pending', response_type: 'yes_no', choices: null, created_at: new Date(Date.now() - 5 * 60_000).toISOString() },
  ] } });
  const r = await run(['approval', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ap_Approv001/);
  assert.match(r.stdout, /Deploy to prod\?/);
  assert.match(r.stdout, /pending/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity approval create POSTs and prints created guid', async () => {
  mock.reset();
  mock.on('POST /approvals', { status: 201, body: { data: { guid: 'ap_NewApprov0' } } });
  const r = await run(['approval', 'create', 'Test', 'approval']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created ap_NewApprov0/);
});

test('gipity approval answer a (approve) resolves a yes_no approval', async () => {
  mock.reset();
  mock.on('GET /approvals/ap_Approv001', { body: { data: { response_type: 'yes_no', choices: null } } });
  mock.on('POST /approvals/ap_Approv001/resolve', { body: { data: { resolved: true } } });
  const r = await run(['approval', 'answer', 'ap_Approv001', 'a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Approved/);
});

test('gipity approval answer --deny sends denied with free-text feedback', async () => {
  mock.reset();
  let resolveBody: Record<string, unknown> | undefined;
  mock.on('POST /approvals/ap_Approv001/resolve', (req) => {
    resolveBody = req.body as Record<string, unknown>;
    return { body: { data: { resolved: true } } };
  });
  const r = await run(['approval', 'answer', 'ap_Approv001', '--deny', 'try', 'again,', 'friendlier', 'tone']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Denied: try again, friendlier tone/);
  assert.deepEqual(resolveBody, { status: 'denied', response: 'try again, friendlier tone' });
});

test('gipity approval cancel <guid> POSTs cancel + prints cancelled', async () => {
  mock.reset();
  mock.on('POST /approvals/ap_Approv001/cancel', { body: { data: { cancelled: true } } });
  const r = await run(['approval', 'cancel', 'ap_Approv001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Cancelled ap_Approv001/);
});

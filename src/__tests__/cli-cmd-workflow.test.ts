import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const WF_A = { short_guid: 'wf_WflowAa0', name: 'Daily', description: 'Runs every day', is_active: 1, trigger_type: 'schedule', cron_expression: '0 8 * * *', project_name: 'Test', project_slug: 'test-project' };
const WF_B = { short_guid: 'wf_WflowBb0', name: 'Manual', description: null, is_active: 0, trigger_type: 'manual', cron_expression: null, project_name: null, project_slug: null };

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity workflow lists workflows with active counters', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A, WF_B], meta: { activeCount: 1, activeLimit: 50 } } });
  const r = await fresh(['workflow']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Active workflows:\s*1\/50/);
  assert.match(r.stdout, /Daily/);
  assert.match(r.stdout, /Manual/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity workflow info <name> resolves by name and shows details', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A, WF_B], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0', { body: { data: { ...WF_A, steps: [{ step_order: 1, name: 'step1', model: 'claude-sonnet-4-6' }] } } });
  const r = await fresh(['workflow', 'info', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Name:\s+Daily/);
  assert.match(r.stdout, /Active:\s+yes/);
  assert.match(r.stdout, /Trigger:\s+schedule/);
  assert.match(r.stdout, /step1/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity workflow run <name> POSTs and prints triggered', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('POST /workflows/wf_WflowAa0/run', { body: { data: { message: 'queued', workflow_guid: 'wf_WflowAa0' } } });
  const r = await fresh(['workflow', 'run', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Triggered "Daily"/);
});

test('gipity workflow runs <name> lists recent runs', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0/runs', { body: { data: [
    { short_guid: 'wr_Run00001', status: 'completed', started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z', total_tokens: 100 },
    { short_guid: 'wr_Run00002', status: 'failed',    started_at: '2026-05-02T10:00:00Z', completed_at: null, total_tokens: 50 },
  ] } });
  const r = await fresh(['workflow', 'runs', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wr_Run00001/);
  assert.match(r.stdout, /completed/);
  assert.match(r.stdout, /failed/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity workflow enable <name> PUTs is_active=true', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  // enable verifies the PUT took effect, so the response must reflect is_active.
  mock.on('PUT /workflows/wf_WflowAa0', { body: { data: { ...WF_A, is_active: 1 } } });
  const r = await fresh(['workflow', 'enable', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Enabled "Daily"/);
});

test('gipity workflow disable <name> PUTs is_active=false', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  // disable verifies is_active went falsy, so the response must reflect that.
  mock.on('PUT /workflows/wf_WflowAa0', { body: { data: { ...WF_A, is_active: 0 } } });
  const r = await fresh(['workflow', 'disable', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Disabled "Daily"/);
});

test('gipity workflow delete <name> calls DELETE', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('DELETE /workflows/wf_WflowAa0', { body: { data: {} } });
  // delete is a soft-delete; the command re-GETs to confirm is_active went 0.
  mock.on('GET /workflows/wf_WflowAa0', { body: { data: { ...WF_A, is_active: 0 } } });
  const r = await fresh(['workflow', 'delete', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted "Daily"/);
});

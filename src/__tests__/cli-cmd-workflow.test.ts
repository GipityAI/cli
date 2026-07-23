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

test('gipity workflow scopes to the linked project by default', async () => {
  mock.reset();
  // WF_A is in the linked project (test-project); WF_B belongs to another project.
  mock.on('GET /workflows', { body: { data: [WF_A, WF_B], meta: { activeCount: 1, activeLimit: 50 } } });
  const r = await fresh(['workflow']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Active workflows:\s*1\/50/);
  assert.match(r.stdout, /Daily/);
  assert.doesNotMatch(r.stdout, /Manual/); // other project's workflow is filtered out
  assert.match(r.stdout, /Project: test-project/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity workflow --all lists every project\'s workflows', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A, WF_B], meta: { activeCount: 1, activeLimit: 50 } } });
  const r = await fresh(['workflow', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Daily/);
  assert.match(r.stdout, /Manual/);
  assert.doesNotMatch(r.stdout, /Project: test-project/);
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

test('gipity workflow run <name> --no-wait POSTs and prints triggered', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('POST /workflows/wf_WflowAa0/run', { body: { data: { message: 'queued', workflow_guid: 'wf_WflowAa0' } } });
  const r = await fresh(['workflow', 'run', 'Daily', '--no-wait']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Triggered "Daily"/);
});

test('gipity workflow run <name> waits by default and prints the run + its steps', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('POST /workflows/wf_WflowAa0/run', { body: { data: { message: 'queued', workflow_guid: 'wf_WflowAa0' } } });
  let listCalls = 0;
  mock.on('GET /workflows/wf_WflowAa0/runs', () => {
    const guid = listCalls++ === 0 ? 'wr_Old00001' : 'wr_New00002';
    return { body: { data: [{ short_guid: guid, status: 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z', total_input_tokens: 0, total_output_tokens: 0 }] } };
  });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_New00002', { body: { data: {
    short_guid: 'wr_New00002', status: 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z',
    total_input_tokens: 0, total_output_tokens: 0,
    step_runs: [{ step_order: 1, step_name: 'summarize', status: 'completed', output_json: { summary: 'ok' }, tokens_used: 0, model_used: null, error_message: null, started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z' }],
  } } });
  // A bare trigger says nothing about what the workflow did; seeing what each
  // step handed the next is the reason you run it, so it must not need a flag.
  const r = await fresh(['workflow', 'run', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wr_New00002/);
  assert.match(r.stdout, /summarize/);
  assert.match(r.stdout, /summary/);
  assert.doesNotMatch(r.stdout, /Triggered/);
});

test('gipity workflow run <name> --wait polls the new run to terminal and prints it', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('POST /workflows/wf_WflowAa0/run', { body: { data: { message: 'queued', workflow_guid: 'wf_WflowAa0' } } });
  // The runs list (?limit=1, query-stripped to this key) returns the OLD run on
  // the pre-trigger capture, then a NEW run once triggered.
  let listCalls = 0;
  mock.on('GET /workflows/wf_WflowAa0/runs', () => {
    const guid = listCalls++ === 0 ? 'wr_Old00001' : 'wr_New00002';
    return { body: { data: [{ short_guid: guid, status: guid === 'wr_New00002' ? 'completed' : 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z', total_input_tokens: 30, total_output_tokens: 20 }] } };
  });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_New00002', { body: { data: {
    short_guid: 'wr_New00002', status: 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z', total_input_tokens: 30, total_output_tokens: 20, step_runs: [],
  } } });
  const r = await fresh(['workflow', 'run', 'Daily', '--wait']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wr_New00002/);
  assert.match(r.stdout, /completed/);
  assert.doesNotMatch(r.stdout, /Triggered/); // --wait prints the run, not the fire-and-forget line
});

test('gipity workflow run <name> --wait prints each step\'s status and output', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('POST /workflows/wf_WflowAa0/run', { body: { data: { message: 'queued', workflow_guid: 'wf_WflowAa0' } } });
  let listCalls = 0;
  mock.on('GET /workflows/wf_WflowAa0/runs', () => {
    const guid = listCalls++ === 0 ? 'wr_Old00001' : 'wr_New00002';
    return { body: { data: [{ short_guid: guid, status: 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z', total_input_tokens: 0, total_output_tokens: 0 }] } };
  });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_New00002', { body: { data: {
    short_guid: 'wr_New00002', status: 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z',
    total_input_tokens: 0, total_output_tokens: 0,
    step_runs: [{ step_order: 1, step_name: 'write_entry', status: 'completed', output_json: { inserted_id: 'loc_42' }, tokens_used: 0, model_used: null, error_message: null, started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z' }],
  } } });
  const r = await fresh(['workflow', 'run', 'Daily', '--wait']);
  assert.equal(r.status, 0, r.stderr);
  // Without the step output a caller can't tell a run that did work from one
  // that silently skipped every step - that's the whole point of --wait.
  assert.match(r.stdout, /inserted_id/);
  assert.match(r.stdout, /loc_42/);
  // "1. completed" alone doesn't say which step ran.
  assert.match(r.stdout, /write_entry/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity workflow run <name> --wait exits non-zero when the run fails', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('POST /workflows/wf_WflowAa0/run', { body: { data: { message: 'queued', workflow_guid: 'wf_WflowAa0' } } });
  let listCalls = 0;
  mock.on('GET /workflows/wf_WflowAa0/runs', () => {
    const guid = listCalls++ === 0 ? 'wr_Old00001' : 'wr_Fail0002';
    return { body: { data: [{ short_guid: guid, status: 'completed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z', total_input_tokens: 0, total_output_tokens: 0 }] } };
  });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_Fail0002', { body: { data: {
    short_guid: 'wr_Fail0002', status: 'failed', started_at: '2026-05-02T10:00:00Z', completed_at: '2026-05-02T10:00:03Z', total_input_tokens: 0, total_output_tokens: 0, error_message: 'step blew up', step_runs: [],
  } } });
  const r = await fresh(['workflow', 'run', 'Daily', '--wait']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /failed/);
  assert.match(r.stdout, /step blew up/);
});

test('gipity workflow runs <name> lists recent runs', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0/runs', { body: { data: [
    { short_guid: 'wr_Run00001', status: 'completed', started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z', total_input_tokens: 80, total_output_tokens: 20 },
    { short_guid: 'wr_Run00002', status: 'failed',    started_at: '2026-05-02T10:00:00Z', completed_at: null, total_input_tokens: 40, total_output_tokens: 10 },
  ] } });
  const r = await fresh(['workflow', 'runs', 'Daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wr_Run00001/);
  assert.match(r.stdout, /completed/);
  assert.match(r.stdout, /failed/);
  // input + output tokens summed; never the literal "undefined".
  assert.match(r.stdout, /100 tokens/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity workflow runs <name> --json emits JSON (flag after positional)', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0/runs', { body: { data: [
    { short_guid: 'wr_Run00001', status: 'completed', started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z', total_input_tokens: 80, total_output_tokens: 20 },
  ] } });
  const r = await fresh(['workflow', 'runs', 'Daily', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed[0].short_guid, 'wr_Run00001');
});

test('gipity workflow runs <name> <runGuid> shows per-step outputs', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_Run00001', { body: { data: {
    short_guid: 'wr_Run00001', status: 'completed', started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z', total_input_tokens: 80, total_output_tokens: 20,
    step_runs: [
      { step_order: 1, status: 'completed', tokens_used: 100, model_used: 'claude-sonnet-4-6', error_message: null, output_json: { sent: true, to: 'user@example.com' }, started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z' },
    ],
  } } });
  const r = await fresh(['workflow', 'runs', 'Daily', 'wr_Run00001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wr_Run00001/);
  assert.match(r.stdout, /completed/);
  assert.match(r.stdout, /"sent": true/);
  assert.match(r.stdout, /user@example\.com/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

// An `llm` step hands the next step `{ result: "<json text>" }`. Printed raw
// that's one escaped line, and it hides the fact the next step sees a STRING
// (so `{{brief.summary}}` resolves to nothing).
test('gipity workflow runs decodes a JSON-string step output and labels it', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_Run00002', { body: { data: {
    short_guid: 'wr_Run00002', status: 'completed', started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z', total_input_tokens: 0, total_output_tokens: 0,
    step_runs: [
      { step_order: 1, step_name: 'brief', status: 'completed', tokens_used: 10, model_used: null, error_message: null, output_json: { result: '{"summary": "quiet night", "drafts": []}' }, started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z' },
    ],
  } } });
  const r = await fresh(['workflow', 'runs', 'Daily', 'wr_Run00002']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"result" \(JSON string\)/);
  assert.match(r.stdout, /"summary": "quiet night"/);
});

// A cut-off llm response still records the step as `completed`; the next step
// then fails with an opaque "could not read X out of the payload". Naming the
// truncation at the source is the difference between one fix and three reruns.
test('gipity workflow runs flags a truncated JSON-string step output', async () => {
  mock.reset();
  mock.on('GET /workflows', { body: { data: [WF_A], meta: { activeCount: 1, activeLimit: 50 } } });
  mock.on('GET /workflows/wf_WflowAa0/runs/wr_Run00003', { body: { data: {
    short_guid: 'wr_Run00003', status: 'failed', started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z', total_input_tokens: 0, total_output_tokens: 0,
    step_runs: [
      { step_order: 1, step_name: 'brief', status: 'completed', tokens_used: 10, model_used: null, error_message: null, output_json: { result: '{"summary": "cut off here' }, started_at: '2026-05-01T10:00:00Z', completed_at: '2026-05-01T10:00:05Z' },
    ],
  } } });
  const r = await fresh(['workflow', 'runs', 'Daily', 'wr_Run00003']);
  assert.match(r.stdout, /truncated\/invalid JSON string/);
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

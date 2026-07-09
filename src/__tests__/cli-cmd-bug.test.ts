/**
 * Happy-path tests for `gipity bug` (report / list / retract) against the mock
 * server. Every test asserts: exit code, expected substring, and no
 * "undefined" in stdout (universal canary for field-name drift).
 */
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

test('gipity bug report files a report and prints its id', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/submit', {
    status: 201,
    body: { data: { report_guid: 'bug_abc12345', created_at: '2026-07-09T10:00:00Z' } },
  });
  const r = await fresh(['bug', 'report', '--category', 'cli', '--severity', 'S3', '--summary', 'deploy help text is stale', '--detail', 'gipity deploy --help mentions a removed flag']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bug_abc12345/);
  assert.match(r.stdout, /queued for triage/i);
  assert.doesNotMatch(r.stdout, /undefined/);
  // The submit body carries the normalized fields.
  const req = mock.requests().find(q => q.url.endsWith('/bug-report/submit'));
  assert.ok(req, 'submit request reached the server');
  assert.equal((req!.body as Record<string, unknown>).category, 'cli');
  assert.equal((req!.body as Record<string, unknown>).severity, 'S3');
});

test('gipity bug list shows severity, summary, status, and id', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/services/bug-report/list', { body: { data: [
    { report_guid: 'bug_abc12345', category: 'cli', severity: 'S3', summary: 'deploy help text is stale', status: 'new', created_at: '2026-07-09T10:00:00Z' },
    { report_guid: 'bug_def67890', category: 'deploy', severity: 'S2', summary: 'deploy stalls on empty dir', status: 'filed', created_at: '2026-07-08T10:00:00Z' },
  ] } });
  const r = await fresh(['bug', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 reports/);
  assert.match(r.stdout, /deploy help text is stale/);
  assert.match(r.stdout, /bug_abc12345/);
  assert.match(r.stdout, /\[filed\]/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity bug retract <id> --reason posts the reason and confirms by id', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/retract', {
    body: { data: { report_guid: 'bug_abc12345', status: 'retracted' } },
  });
  const r = await fresh(['bug', 'retract', 'bug_abc12345', '--reason', 'my own typo, not a platform bug']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bug_abc12345/);
  assert.match(r.stdout, /retracted/i);
  assert.doesNotMatch(r.stdout, /undefined/);
  const req = mock.requests().find(q => q.url.endsWith('/bug-report/retract'));
  assert.ok(req, 'retract request reached the server');
  assert.equal((req!.body as Record<string, unknown>).report_guid, 'bug_abc12345');
  assert.equal((req!.body as Record<string, unknown>).reason, 'my own typo, not a platform bug');
});

test('gipity bug retract --json emits the raw response', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/retract', {
    body: { data: { report_guid: 'bug_abc12345', status: 'retracted' } },
  });
  const r = await fresh(['bug', 'retract', 'bug_abc12345', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.report_guid, 'bug_abc12345');
  assert.equal(parsed.status, 'retracted');
});

test('gipity bug retract surfaces the server message on an already-processed report', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/retract', {
    status: 409,
    body: { error: { code: 'CONFLICT', message: "This report is already 'filed' — it has been picked up by a human, who will handle closing it out." } },
  });
  const r = await fresh(['bug', 'retract', 'bug_abc12345']);
  assert.notEqual(r.status, 0, 'a 4xx must exit non-zero');
  assert.match(r.stdout + r.stderr, /already 'filed'/);
  assert.match(r.stdout + r.stderr, /picked up by a human/);
});

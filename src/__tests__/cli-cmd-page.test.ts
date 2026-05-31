import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';
import { timestampSlug, defaultFilename } from '../commands/page-screenshot.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function run(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

const baseBundle = {
  url: 'https://example.com',
  title: 'Example Domain',
  console: ['Warning: deprecated API'],
  failedResources: [],
  timing: { ttfb: 120, domReady: 500, load: 800 },
  elementCount: 42,
  totalBytes: 12345,
  largeResources: [],
  renderBlocking: [],
  oversizedImages: [],
  lcp: null,
  overflow: { scrollWidth: 1280, clientWidth: 1280, overflowX: false, amount: 0, culprits: [] },
};

test('gipity page inspect prints title, timing, and console summary', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Example Domain/);
  assert.match(r.stdout, /TTFB:\s*120ms/);
  assert.match(r.stdout, /Warning: deprecated API/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity page inspect reports a clean layout when there is no horizontal overflow', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no horizontal overflow/);
});

test('gipity page inspect flags horizontal overflow and lists culprits under --all', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    overflow: {
      scrollWidth: 1400, clientWidth: 1280, overflowX: true, amount: 120,
      culprits: [{ tag: 'div', cls: 'hero wide', left: 0, right: 1400, width: 1400 }],
    },
  } } });
  const r = await run(['page', 'inspect', 'https://example.com', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Horizontal overflow: \+120px/);
  assert.match(r.stdout, /div\.hero/);
});

test('gipity page inspect treats the implicit root /favicon.ico 404 as a note, not a failure', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle, failedResources: ['https://dev.gipity.ai/favicon.ico (404)'],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Failed resources/);
  assert.match(r.stdout, /No root \/favicon\.ico/);
});

test('gipity page inspect still flags real failed resources alongside the favicon note', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    failedResources: ['https://dev.gipity.ai/favicon.ico (404)', 'https://dev.gipity.ai/app.js (500)'],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Failed resources \(1\)/);
  assert.match(r.stdout, /app\.js \(500\)/);
  assert.doesNotMatch(r.stdout, /favicon\.ico \(404\)/);
  assert.match(r.stdout, /No root \/favicon\.ico/);
});

test('gipity page inspect --fake-media forwards fakeMedia in the request body', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com', '--fake-media']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.ok(req, 'inspect request was received');
  assert.equal((req!.body as { fakeMedia?: boolean }).fakeMedia, true);
});

test('gipity page inspect omits fakeMedia when --fake-media is absent', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.equal((req!.body as { fakeMedia?: boolean }).fakeMedia, undefined);
});

test('gipity page inspect --json emits the raw inspect bundle', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle, url: 'https://x.example', title: 'X', console: [],
  } } });
  const r = await run(['page', 'inspect', 'https://x.example', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.title, 'X');
  assert.equal(parsed.overflow.overflowX, false);
});

// Eval is async: POST returns a job id, the CLI polls GET until the job is
// done. The mock returns a fixed evalJobId and the matching done record.
test('gipity page eval prints the serialized expression result', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-1', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-1', { body: { data: {
    status: 'done', url: 'https://example.com', result: 'Example Domain', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Example Domain/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity page eval --json emits url, result, and truncated', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-1', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-1', { body: { data: {
    status: 'done', url: 'https://example.com', result: '42', truncated: true,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '1+41', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.result, '42');
  assert.equal(parsed.truncated, true);
});

test('gipity page eval surfaces a failed eval job', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-err', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-err', { body: { data: {
    status: 'error', httpStatus: 502, code: 'BROWSER_ERROR', reason: 'stayed on about:blank',
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /about:blank/);
});

// ── screenshot default filename helpers (pure) ─────────────────────────────

test('timestampSlug renders yyyy-mm-dd_hh-mm-ss, zero-padded, sortable', () => {
  // 2026-05-31 09:07:03 local time
  const slug = timestampSlug(new Date(2026, 4, 31, 9, 7, 3));
  assert.equal(slug, '2026-05-31_09-07-03');
  // No colons (path-safe) and lexical order tracks chronological order.
  assert.doesNotMatch(slug, /:/);
  const earlier = timestampSlug(new Date(2026, 4, 31, 9, 7, 2));
  assert.ok(earlier < slug);
});

test('defaultFilename composes ss-<slug>-<ts>.png, inserting viewport suffix when present', () => {
  const ts = '2026-05-31_09-07-03';
  assert.equal(defaultFilename('example-com', ts), 'ss-example-com-2026-05-31_09-07-03.png');
  assert.equal(
    defaultFilename('example-com', ts, '1280x720'),
    'ss-example-com-1280x720-2026-05-31_09-07-03.png',
  );
});

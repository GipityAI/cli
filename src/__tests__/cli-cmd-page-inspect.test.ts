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

test('gipity page-inspect prints title, timing, and console summary', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
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
  } } });
  const r = await run(['page-inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Example Domain/);
  assert.match(r.stdout, /TTFB:\s*120ms/);
  assert.match(r.stdout, /Warning: deprecated API/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity page-inspect --json emits the raw inspect bundle', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    url: 'https://x.example', title: 'X', console: [], failedResources: [],
    timing: { ttfb: 1, domReady: 2, load: 3 }, elementCount: 1, totalBytes: 100,
    largeResources: [], renderBlocking: [], oversizedImages: [], lcp: null,
  } } });
  const r = await run(['page-inspect', 'https://x.example', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.title, 'X');
});

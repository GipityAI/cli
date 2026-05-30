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

test('gipity service list shows the service catalog', async () => {
  mock.reset();
  const r = await fresh(['service', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /llm/);
  assert.match(r.stdout, /image/);
  assert.match(r.stdout, /music/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity service call <name> [body] POSTs to /services/<name> and prints the raw response', async () => {
  mock.reset();
  // Service responses are NOT wrapped in { data } - the whole body is printed.
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [{ message: { content: 'ok' } }] } });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"hi"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /choices/);
  assert.match(r.stdout, /ok/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity service call preserves subpaths (location/geocode)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/location/geocode', { body: { city: 'Portland' } });
  const r = await fresh(['service', 'call', 'location/geocode', '{"lat":45.5,"lon":-122.6}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Portland/);
});

test('gipity service call --get issues a GET (listing endpoints)', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/services/llm/models', { body: { data: { models: [{ id: 'claude-sonnet-4-6' }] } } });
  const r = await fresh(['service', 'call', 'llm/models', '--get']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude-sonnet-4-6/);
});

import { test, before, after } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ── the anonymous visitor path ────────────────────────────────────────────────
// An owner-authenticated service call succeeds no matter what billing_mode the
// app declares, so it proves nothing about the signed-out visitors a public page
// actually serves. --anon calls the same endpoint with the visitor's app token,
// which is the only way to see the user_pays 401 before a real customer does.

test('gipity service call --anon mints a visitor token and calls the public path', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 'app_tok_1' } } });
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [{ message: { content: 'we close at 2pm' } }] } });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"closing time?"}', '--anon']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /we close at 2pm/);
  // Identity is named on stderr so a "the service works" check can't quietly be
  // the owner persona.
  assert.match(r.stderr, /anonymous visitor/);
  // The visitor token is minted first, then spent on the service call.
  const urls = mock.requests().map((q) => q.url);
  assert.ok(urls.includes('/api/token'), 'expected a visitor token to be minted');
  assert.ok(urls.includes('/api/p_TestProj/services/llm'), 'expected the service to be called');
});

test('gipity service call names the owner persona (and points at --anon) by default', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [] } });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"hi"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /owner persona/);
  assert.match(r.stderr, /--anon/);
});

test('gipity service call --anon turns a LOGIN_REQUIRED 401 into the billing_mode fix', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 'app_tok_1' } } });
  mock.on('POST /api/p_TestProj/services/llm', {
    status: 401,
    body: { error: { code: 'LOGIN_REQUIRED', message: 'Please log in to use this feature' } },
  });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"hi"}', '--anon']);
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  assert.match(out, /user_pays/);
  assert.match(out, /billing_mode: owner_pays/);
  assert.match(out, /gipity\.yaml/);
});

test('gipity service call -d and --field work like fn call', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [{ message: { content: 'hello' } }] } });
  const r = await fresh(['service', 'call', 'llm', '-d', '{"prompt":"hi"}', '--field', 'choices.0.message.content']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'hello');
});

// ── multipart uploads (--form) ────────────────────────────────────────────────
// transcribe takes a real multipart upload with an `audio` file field, not the
// { data, media_type } JSON shape --file builds, so --form sends multipart.

test('gipity service call --form sends multipart with the file and text fields', async () => {
  mock.reset();
  let seen: { contentType: string; body: string } | undefined;
  mock.on('POST /api/p_TestProj/services/transcribe', (req) => {
    seen = { contentType: String(req.headers['content-type']), body: String(req.body) };
    return { body: { text: 'hello world', language: 'en' } };
  });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(dir, 'talk.mp3'), 'ID3fake-audio-bytes');
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'service', 'call', 'transcribe', '--form', 'audio=@talk.mp3', '--form', 'language=en', '--form', 'diarize=true'],
    { env: { HOME: home }, cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello world/);
  assert.ok(seen, 'expected the transcribe endpoint to be called');
  assert.match(seen.contentType, /^multipart\/form-data; boundary=/);
  assert.match(seen.body, /name="audio"; filename="talk\.mp3"/);
  assert.match(seen.body, /Content-Type: audio\/mpeg/);
  assert.match(seen.body, /ID3fake-audio-bytes/);
  assert.match(seen.body, /name="language"\r\n\r\nen\r\n/);
  assert.match(seen.body, /name="diarize"\r\n\r\ntrue\r\n/);
});

test('gipity service call --form refuses to mix with a JSON body', async () => {
  mock.reset();
  const r = await fresh(['service', 'call', 'transcribe', '{"x":1}', '--form', 'language=en']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /cannot be combined/);
  assert.equal(mock.requests().length, 0);
});

test('gipity service call --form names a missing file', async () => {
  mock.reset();
  const r = await fresh(['service', 'call', 'transcribe', '--form', 'audio=@nope.mp3']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Cannot read --form 'nope\.mp3'/);
  assert.equal(mock.requests().length, 0);
});

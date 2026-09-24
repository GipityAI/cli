import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runCliAsync, CLI_ENTRY } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { buildAskPrompt } from '../commands/ask.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

const ASK_URL = 'POST /projects/p_TestProj/generate/text';
const ANSWER = { text: '  425 means Too Early.\n', model: 'claude-haiku-4-5', input_tokens: 20, output_tokens: 6, truncated: false };

function ask(args: string[], opts: { dir?: string; input?: string } = {}) {
  const cwd = opts.dir ?? makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, 'ask', ...args], { env: { HOME: home }, cwd, input: opts.input });
}

function lastBody(): Record<string, unknown> {
  return mock.requests().filter(q => q.url === '/projects/p_TestProj/generate/text').pop()!.body as Record<string, unknown>;
}

test('gipity ask prints the answer and sends the question, model and system prompt', async () => {
  mock.reset();
  mock.on(ASK_URL, { body: ANSWER });
  const r = await ask(['what', 'does', 'HTTP 425 mean?', '--model', 'haiku', '--system', 'Be terse.']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '425 means Too Early.');
  assert.deepEqual(lastBody(), { prompt: 'what does HTTP 425 mean?', model: 'haiku', system: 'Be terse.' });
});

test('gipity ask --file adds each file under a header, and --file - reads stdin', async () => {
  mock.reset();
  mock.on(ASK_URL, { body: ANSWER });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(dir, 'notes.md'), 'line one\nline two\n');
  const r = await ask(['summarize', '--file', 'notes.md', '-'], { dir, input: 'piped text\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastBody().prompt, 'summarize\n\n--- notes.md ---\nline one\nline two\n\npiped text');
});

test('gipity ask with nothing but a shell pipe uses it as the prompt', async () => {
  // A real shell pipe (a FIFO). Node's spawn stdin is a socket, so this goes
  // through sh to get the shape `echo x | gipity ask` has in a terminal.
  mock.reset();
  mock.on(ASK_URL, { body: ANSWER });
  const cwd = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync([], {
    env: { HOME: home }, cwd,
    shell: `printf 'translate "hola"' | "${process.execPath}" "${CLI_ENTRY}" --api-base ${mock.apiBase} ask`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastBody().prompt, 'translate "hola"');
});

test('gipity ask with a question never waits on an open stdin pipe', async () => {
  // runCliAsync leaves stdin as an open, never-closed pipe unless `input` is set -
  // the shape many agent harnesses use. The question alone must be enough.
  mock.reset();
  mock.on(ASK_URL, { body: ANSWER });
  const r = await ask(['ping']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastBody().prompt, 'ping');
});

test('gipity ask --schema sends the schema and prints the parsed JSON', async () => {
  mock.reset();
  mock.on(ASK_URL, { body: { ...ANSWER, text: '["2026-09-01"]', json: ['2026-09-01'] } });
  const r = await ask(['extract dates', '--schema', '{"type":"array","items":{"type":"string"}}']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['2026-09-01']);
  assert.deepEqual(lastBody().schema, { type: 'array', items: { type: 'string' } });
});

test('gipity ask --json prints the whole result', async () => {
  mock.reset();
  mock.on(ASK_URL, { body: ANSWER });
  const r = await ask(['ping', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ANSWER);
});

test('gipity ask rejects bad input before calling the server', async () => {
  mock.reset();
  const empty = await ask([]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Nothing to ask/);
  const badSchema = await ask(['x', '--schema', '{not json']);
  assert.match(badSchema.stderr, /--schema must be JSON/);
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(dir, 'doc.pdf'), '%PDF');
  const badImage = await ask(['x', '--image', 'doc.pdf'], { dir });
  assert.match(badImage.stderr, /--image doc\.pdf is application\/pdf; use a png, jpg, gif or webp/);
  assert.equal(mock.requests().length, 0);
});

test('gipity ask warns on stderr when the answer was cut off', async () => {
  mock.reset();
  mock.on(ASK_URL, { body: { ...ANSWER, truncated: true } });
  const r = await ask(['long essay']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cut off/);
});

test('buildAskPrompt joins the question and files', () => {
  assert.equal(buildAskPrompt(['a', 'b'], []), 'a b');
  assert.equal(buildAskPrompt([], [{ path: '-', content: 'x\n' }]), 'x');
  assert.equal(buildAskPrompt(['q'], [{ path: 'f.txt', content: 'y' }]), 'q\n\n--- f.txt ---\ny');
});

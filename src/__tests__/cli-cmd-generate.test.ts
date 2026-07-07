import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  // Use a fresh project dir; downloadFile writes to cwd, so isolate per-test.
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity generate image POSTs and downloads from the returned URL', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/generate/image', { body: {
    url: `${mock.apiBase}/files/generated.png`,
    content_type: 'image/png',
    model: 'flux-2-pro',
    provider: 'bfl',
    size_bytes: 12,
  } });
  // 12 bytes of fake PNG data
  mock.on('GET /files/generated.png', { contentType: 'image/png', raw: 'fakepng12bts' });
  const r = await fresh(['generate', 'image', 'a cat with a hat']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Generated with bfl\/flux-2-pro/);
  // Absolute path so the agent knows exactly where the file landed.
  assert.match(r.stdout, /Saved to \/.*\/generated\.png/);
});

test('gipity generate surfaces an out-of-credits 402 with the buy link', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/generate/image', {
    status: 402,
    body: { error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits. Buy more at https://prompt.gipity.ai/pricing' } },
  });
  const r = await fresh(['generate', 'image', 'a cat with a hat']);
  assert.notEqual(r.status, 0);
  // Plainly flagged so an agent reading the output knows it's a credits issue...
  assert.match(r.stderr, /out of Gipity credits/i);
  // ...and the buy link from the server message is preserved.
  assert.match(r.stderr, /https:\/\/prompt\.gipity\.ai\/pricing/);
  // ...plus the actionable CLI next-step so the user knows how to top up.
  assert.match(r.stderr, /gipity credits buy/);
});

test('gipity generate speech --provider POSTs and writes the audio file', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/generate/speech', { body: {
    url: `${mock.apiBase}/files/speech.mp3`,
    content_type: 'audio/mpeg',
    model: 'eleven_v3',
    provider: 'elevenlabs',
    size_bytes: 12,
  } });
  mock.on('GET /files/speech.mp3', { contentType: 'audio/mpeg', raw: 'fakeaudiobts' });
  const r = await fresh(['generate', 'speech', 'Hello world', '--provider', 'elevenlabs']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Generated with elevenlabs/);
  assert.match(r.stdout, /Saved to \/.*\/speech\.mp3/);
});

test('gipity generate sound POSTs text + options and writes the audio file', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/generate/sound', { body: {
    url: `${mock.apiBase}/files/sound.mp3`,
    content_type: 'audio/mpeg',
    model: '',
    provider: 'gipity',
    size_bytes: 12,
  } });
  mock.on('GET /files/sound.mp3', { contentType: 'audio/mpeg', raw: 'fakeaudiobts' });
  const r = await fresh(['generate', 'sound', 'cartoon character saying oof', '--duration', '2.5', '--influence', '0.7']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Generated sound effect/);
  assert.match(r.stdout, /Saved to \/.*\/sound\.mp3/);

  const req = mock.requests().find(q => q.url === '/projects/p_TestProj/generate/sound');
  assert.ok(req, 'sound generate request was made');
  const body = req!.body as { text: string; duration_seconds: number; prompt_influence: number };
  assert.equal(body.text, 'cartoon character saying oof');
  assert.equal(body.duration_seconds, 2.5);
  assert.equal(body.prompt_influence, 0.7);
});

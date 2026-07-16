import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
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

/** Same as `fresh`, but hands back the project dir so a test can assert on the
 *  files that landed in it. */
function freshIn(dir: string, args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: dir });
}

function mockSound() {
  mock.on('POST /projects/p_TestProj/generate/sound', { body: {
    url: `${mock.apiBase}/files/sound.mp3`,
    content_type: 'audio/mpeg',
    model: '',
    provider: 'gipity',
    size_bytes: 12,
  } });
  mock.on('GET /files/sound.mp3', { contentType: 'audio/mpeg', raw: 'fakeaudiobts' });
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

// The image models return whatever format they feel like — a BFL "png" request
// comes back as JPEG — but an explicit -o path is a name the caller has committed
// to and will chain the NEXT command against (`--input fist.png`, `page eval
// --camera fist.png`). Renaming it to match the bytes moves the file out from
// under that already-written second command, costing a "saved as .jpg, retry with
// the right path" turn. So an explicit -o is honoured VERBATIM (every downstream
// consumer sniffs the bytes, not the name), with the format mismatch stated.
test('gipity generate image honours the explicit -o path verbatim', async () => {
  mock.reset();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('\x00\x10JFIF\x00')]);
  mock.on('POST /projects/p_TestProj/generate/image', { body: {
    url: `${mock.apiBase}/files/out.bin`,
    content_type: 'image/png',   // even the server's content_type can be wrong
    model: 'flux-2-pro', provider: 'bfl', size_bytes: jpeg.length,
  } });
  mock.on('GET /files/out.bin', { contentType: 'image/png', raw: jpeg });

  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshIn(dir, ['generate', 'image', 'a closed fist', '-o', 'tmp/fist.png']);
  assert.equal(r.status, 0, r.stderr);

  // Saved at the EXACT requested path so the chained next command just works,
  // and the format mismatch is stated (not silent) rather than renaming the file.
  assert.match(r.stdout, /Saved to \/.*\/tmp\/fist\.png/);
  assert.match(r.stderr, /holds JPEG bytes/);
  assert.equal(readFileSync(join(dir, 'tmp', 'fist.png'))[0], 0xff);
  // No surprise second path — the file is where, and only where, it was asked for.
  assert.throws(() => readFileSync(join(dir, 'tmp', 'fist.jpg')));
});

// The auto-generated default filename (no -o) has no committed path to break, so
// there we DO name the file after its real bytes — a tidy, honest extension.
test('gipity generate image names the default file after the bytes', async () => {
  mock.reset();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('\x00\x10JFIF\x00')]);
  mock.on('POST /projects/p_TestProj/generate/image', { body: {
    url: `${mock.apiBase}/files/out.bin`,
    content_type: 'image/png',
    model: 'flux-2-pro', provider: 'bfl', size_bytes: jpeg.length,
  } });
  mock.on('GET /files/out.bin', { contentType: 'image/png', raw: jpeg });

  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshIn(dir, ['generate', 'image', 'a closed fist']);
  assert.equal(r.status, 0, r.stderr);

  assert.match(r.stdout, /Saved to \/.*\/generated\.jpg/);
  assert.match(r.stderr, /returned JPEG, not PNG/);
  assert.equal(readFileSync(join(dir, 'generated.jpg'))[0], 0xff);
  assert.throws(() => readFileSync(join(dir, 'generated.png')));
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

test('gipity generate sound creates a missing -o parent directory', async () => {
  mock.reset();
  mockSound();
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  // `src/audio/` does not exist - the natural place for an audio asset in a
  // freshly scaffolded app, and what used to blow up with a raw ENOENT.
  const r = await freshIn(dir, ['generate', 'sound', 'warm two-tone doorbell chime', '-o', 'src/audio/ding.mp3']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'src', 'audio', 'ding.mp3'), 'utf8'), 'fakeaudiobts');
});

test('gipity generate image creates a missing -o parent directory', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/generate/image', { body: {
    url: `${mock.apiBase}/files/generated.png`,
    content_type: 'image/png',
    model: 'flux-2-pro',
    provider: 'bfl',
    size_bytes: 12,
  } });
  mock.on('GET /files/generated.png', { contentType: 'image/png', raw: 'fakepng12bts' });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshIn(dir, ['generate', 'image', 'a tee shirt', '-o', 'src/images/products/tee.png']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'src', 'images', 'products', 'tee.png'), 'utf8'), 'fakepng12bts');
});

test('generate rejects an unusable -o path before spending a paid generation', async () => {
  mock.reset();
  mockSound();
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(dir, 'blocker'), 'a file, not a directory');
  const r = await freshIn(dir, ['generate', 'sound', 'a ding', '-o', 'blocker/nested/ding.mp3']);
  assert.notEqual(r.status, 0);
  // Names what the CLI actually needed, rather than leaking a raw fs errno.
  assert.match(r.stderr, /can't create the output directory/);
  // The whole point of checking up front: generation is billed per call, so the
  // request must never leave the machine when the file can't be saved.
  assert.equal(mock.requests().filter(q => q.url.includes('/generate/')).length, 0,
    'no generation request should be made when the output path is unusable');
});

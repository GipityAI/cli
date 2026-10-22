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

function mockVideo() {
  mock.on('POST /projects/p_TestProj/generate/video', { body: {
    url: `${mock.apiBase}/files/generated.mp4`,
    content_type: 'video/mp4',
    model: 'gemini-omni-1.1-flash',
    provider: 'gemini',
    size_bytes: 1223680,
    duration_seconds: 4,
    credits_deducted: 1680,
    remaining_balance: 48320,
  } });
  mock.on('GET /files/generated.mp4', { contentType: 'video/mp4', raw: 'fakemp4bytess' });
}

test('gipity generate video reports duration, time, speed, and credits metrics', async () => {
  mock.reset();
  mockVideo();
  const r = await fresh(['generate', 'video', 'a wave crashing']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Generated with gemini\/gemini-omni-1\.1-flash/);
  // One labeled metric per line, so an agent (or human) can scan the column.
  assert.match(r.stdout, /duration: 4s clip/);
  assert.match(r.stdout, /size: 1195KB/);
  assert.match(r.stdout, /time: [\d.]+m? ?[\d.]*s/);
  assert.match(r.stdout, /speed: [\d.]+x realtime/);
  assert.match(r.stdout, /credits: 1,680 \(48,320 remaining\)/);
  assert.match(r.stdout, /Saved to \/.*\/generated\.mp4/);
});

test('gipity generate video --json carries the metadata fields through', async () => {
  mock.reset();
  mockVideo();
  const r = await fresh(['generate', 'video', 'a wave crashing', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.model, 'gemini-omni-1.1-flash');
  assert.equal(out.duration_seconds, 4);
  assert.equal(out.credits_deducted, 1680);
  assert.equal(out.remaining_balance, 48320);
  assert.equal(typeof out.generation_seconds, 'number');
  assert.match(out.saved, /\/generated\.mp4$/);
});

// Free/unpriced operations come back with no credits fields at all (the server
// omits them rather than sending placeholder zeros) - the metric line must be
// absent, not "0 credits (0 remaining)".
test('gipity generate omits the credits line when nothing was deducted', async () => {
  mock.reset();
  mockSound();
  const r = await fresh(['generate', 'sound', 'a ding']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Generated sound effect/);
  assert.doesNotMatch(r.stdout, /credits:/);
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

// ── generate music: lyrics flags ────────────────────────────────────────
// The lyrics/vocals/instrumental mapping is pure client-side logic, so pin it
// here against the mock server: what the CLI actually PUTS IN THE BODY is the
// contract the platform validates.

function mockMusic() {
  mock.on('POST /projects/p_TestProj/generate/music', { body: {
    url: `${mock.apiBase}/files/music.mp3`,
    content_type: 'audio/mpeg',
    model: 'music-v1',
    provider: 'gipity',
    size_bytes: 12,
    duration_seconds: 30,
  } });
  mock.on('GET /files/music.mp3', { contentType: 'audio/mpeg', raw: 'fakemusicbts' });
}

function musicRequestBody(): Record<string, unknown> {
  const req = mock.requests().find(q => q.url.includes('/generate/music'));
  assert.ok(req, 'expected a /generate/music request');
  return req!.body as Record<string, unknown>;
}

test('generate music defaults to instrumental with no lyrics field', async () => {
  mock.reset();
  mockMusic();
  const r = await fresh(['generate', 'music', 'calm piano']);
  assert.equal(r.status, 0, r.stderr);
  const body = musicRequestBody();
  assert.equal(body['instrumental'], true);
  assert.ok(!('lyrics' in body) || body['lyrics'] === undefined, 'no lyrics key without a lyrics flag');
});

test('generate music --lyrics sends the words and flips instrumental off', async () => {
  mock.reset();
  mockMusic();
  const r = await fresh(['generate', 'music', '80s synth-pop', '--lyrics', '[Verse]\nExact words to sing']);
  assert.equal(r.status, 0, r.stderr);
  const body = musicRequestBody();
  assert.equal(body['lyrics'], '[Verse]\nExact words to sing');
  assert.equal(body['instrumental'], false, 'lyrics imply vocals');
});

test('generate music --lyrics-file reads and trims the file contents', async () => {
  mock.reset();
  mockMusic();
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(dir, 'words.txt'), '[Hook]\nSing it from a file\n\n');
  const r = await freshIn(dir, ['generate', 'music', 'folk ballad', '--lyrics-file', 'words.txt']);
  assert.equal(r.status, 0, r.stderr);
  const body = musicRequestBody();
  assert.equal(body['lyrics'], '[Hook]\nSing it from a file');
  assert.equal(body['instrumental'], false);
});

test('generate music rejects --lyrics with --lyrics-file before any request', async () => {
  mock.reset();
  mockMusic();
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(dir, 'words.txt'), 'file words');
  const r = await freshIn(dir, ['generate', 'music', 'jazz', '--lyrics', 'inline words', '--lyrics-file', 'words.txt']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--lyrics or --lyrics-file, not both/);
  assert.equal(mock.requests().filter(q => q.url.includes('/generate/')).length, 0,
    'the conflict must be caught before a paid generation request leaves the machine');
});

// ── Queued (async) image generations: Gipity GPU models ─────────────────

const GENS = '/projects/p_TestProj/generate/image/generations';

function gen(over: Record<string, unknown> = {}) {
  return {
    id: 'gen_aaaa1111', object: 'image.generation', status: 'queued', model: 'gipity-krea2-realistic',
    prompt: 'a red canoe', seed: 42, width: 832, height: 1216, metadata: null,
    queue_position: 3, eta_ms: 95_000, phase: null, step: null, total: null, progress: 0,
    outputs: null, error: null, credits_charged: null, created_at: '2026-10-22T10:00:00Z', started_at: null, finished_at: null,
    ...over,
  };
}

function done(id: string, url: string, over: Record<string, unknown> = {}) {
  return gen({
    id, status: 'succeeded', queue_position: null, eta_ms: null, progress: 1, credits_charged: 8,
    outputs: { full: { url, mime: 'image/jpeg', bytes: 12, width: 832, height: 1216 } }, ...over,
  });
}

/** Run with a fast poll so the wait loop doesn't slow the suite. */
function freshFast(dir: string, args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home, GIPITY_GENERATE_POLL_MS: '10' }, cwd: dir });
}

test('gipity generate image with a gipity-* model queues, waits through the states, and saves the file', async () => {
  mock.reset();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('\x00\x10JFIF\x00')]);
  mock.on(`POST ${GENS}`, { status: 202, body: { data: [gen()] } });
  const states = [
    gen({ queue_position: 1 }),
    gen({ status: 'running', queue_position: null, phase: 'sampling', step: 4, total: 8, progress: 0.5 }),
    done('gen_aaaa1111', `${mock.apiBase}/files/canoe.jpg`),
  ];
  let polls = 0;
  mock.on(`GET ${GENS}`, () => ({ body: { data: [states[Math.min(polls++, states.length - 1)]] } }));
  mock.on('GET /files/canoe.jpg', { contentType: 'image/jpeg', raw: jpeg });

  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'image', 'a red canoe', '--model', 'gipity-krea2-realistic', '--aspect', 'portrait', '--seed', '42']);
  assert.equal(r.status, 0, r.stderr);

  const submit = mock.requests().find((q) => q.method === 'POST' && q.url === GENS)!;
  assert.deepEqual(submit.body, { model: 'gipity-krea2-realistic', prompt: 'a red canoe', aspect: 'portrait', seed: 42 });
  // Non-TTY: one plain line per state change, never a \r redraw.
  assert.match(r.stdout, /queued: 2 ahead, about 2 min/);
  assert.match(r.stdout, /queued: next up, about 2 min/);
  assert.match(r.stdout, /rendering 4\/8/);
  assert.doesNotMatch(r.stdout, /\r/);
  assert.match(r.stdout, /Generated with gipity\/gipity-krea2-realistic/);
  assert.match(r.stdout, /credits: 8/);
  assert.match(r.stdout, /Saved gen_aaaa1111 to \/.*\/generated\.jpg/);
  assert.equal(readFileSync(join(dir, 'generated.jpg'))[0], 0xff);
  // The sync image route was never used for a queued model.
  assert.equal(mock.requests().some((q) => q.url === '/projects/p_TestProj/generate/image'), false);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity generate image --n 2 -o numbers the files and sends n', async () => {
  mock.reset();
  mock.on(`POST ${GENS}`, { status: 202, body: { data: [gen({ id: 'gen_one11111' }), gen({ id: 'gen_two22222', seed: 43 })] } });
  mock.on(`GET ${GENS}`, { body: { data: [
    done('gen_one11111', `${mock.apiBase}/files/a.jpg`),
    done('gen_two22222', `${mock.apiBase}/files/b.jpg`, { seed: 43 }),
  ] } });
  mock.on('GET /files/a.jpg', { contentType: 'image/jpeg', raw: Buffer.from([0xff, 0xd8, 0xff, 0x01]) });
  mock.on('GET /files/b.jpg', { contentType: 'image/jpeg', raw: Buffer.from([0xff, 0xd8, 0xff, 0x02]) });

  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'image', 'canoes', '--model', 'gipity-krea2-realistic', '--n', '2', '-o', 'out/canoe.jpg']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((mock.requests().find((q) => q.method === 'POST')!.body as any).n, 2);
  assert.match(r.stdout, /Saved gen_one11111 to \/.*\/out\/canoe-1\.jpg/);
  assert.match(r.stdout, /Saved gen_two22222 to \/.*\/out\/canoe-2\.jpg/);
  assert.equal(readFileSync(join(dir, 'out', 'canoe-2.jpg'))[3], 0x02);
  assert.match(r.stdout, /credits: 16/);
});

test('gipity generate image --no-wait queues, prints ids and how to check, and never polls', async () => {
  mock.reset();
  mock.on(`POST ${GENS}`, { status: 202, body: { data: [gen()] } });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'image', 'a red canoe', '--model', 'gipity-krea2-realistic', '--no-wait', '--ref', 'gen_prev1111', '--nsfw', '--avoid', 'blur', '--format', 'png']);
  assert.equal(r.status, 0, r.stderr);
  const body = mock.requests().find((q) => q.method === 'POST')!.body as any;
  assert.deepEqual(body.references, ['gen_prev1111']);
  assert.equal(body.nsfw, true);
  assert.equal(body.avoid, 'blur');
  assert.equal(body.format, 'png');
  assert.match(r.stdout, /gen_aaaa1111\s+queued: 2 ahead/);
  assert.match(r.stdout, /gipity generate status gen_aaaa1111/);
  assert.equal(mock.requests().filter((q) => q.method === 'GET').length, 0);
});

test('gipity generate image --json on a queued model keeps stdout pure JSON', async () => {
  mock.reset();
  mock.on(`POST ${GENS}`, { status: 202, body: { data: [gen()] } });
  mock.on(`GET ${GENS}`, { body: { data: [done('gen_aaaa1111', `${mock.apiBase}/files/c.jpg`)] } });
  mock.on('GET /files/c.jpg', { contentType: 'image/jpeg', raw: Buffer.from([0xff, 0xd8, 0xff, 0x03]) });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'image', 'a red canoe', '--model', 'gipity-krea2-realistic', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out[0].id, 'gen_aaaa1111');
  assert.equal(out[0].status, 'succeeded');
  assert.match(out[0].saved, /generated\.jpg$/);
});

test('a failed or expired queued generation exits 1 with the reason and saves nothing', async () => {
  mock.reset();
  mock.on(`POST ${GENS}`, { status: 202, body: { data: [gen()] } });
  mock.on(`GET ${GENS}`, { body: { data: [gen({ status: 'failed', error: { code: 'content_blocked', message: 'That prompt was blocked.' } })] } });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'image', 'x', '--model', 'gipity-krea2-realistic']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gen_aaaa1111 failed: That prompt was blocked\./);
  assert.throws(() => readFileSync(join(dir, 'generated.jpg')));
});

test('submit errors (NSFW not allowed) surface the server message', async () => {
  mock.reset();
  mock.on(`POST ${GENS}`, { status: 403, body: { error: { code: 'NSFW_NOT_ALLOWED', message: 'NSFW models need "Allow NSFW services" turned on for your Gipity account.' } } });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'image', 'x', '--model', 'gipity-krea2-nsfw', '--nsfw']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Allow NSFW services/);
});

test('gipity generate status / cancel / list read the generations API', async () => {
  mock.reset();
  mock.on(`GET ${GENS}`, (req) => ({ body: { data: req.url.includes('status=open')
    ? [gen()]
    : req.url.includes('ids=')
      ? [done('gen_aaaa1111', 'https://media.example/x.jpg')]
      : [done('gen_aaaa1111', 'https://media.example/x.jpg'), gen({ id: 'gen_bbbb2222', status: 'expired' })] } }));
  mock.on(`POST ${GENS}/gen_aaaa1111/cancel`, { body: { data: gen({ status: 'cancelled' }) } });
  const dir = makeProjectDir({ apiBase: mock.apiBase });

  const s = await freshFast(dir, ['generate', 'status', 'gen_aaaa1111', 'gen_missing1']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /gen_aaaa1111\s+gipity-krea2-realistic\s+done/);
  assert.match(s.stdout, /url: https:\/\/media\.example\/x\.jpg/);
  assert.match(s.stdout, /gen_missing1\s+not found/);
  assert.ok(mock.requests().some((q) => q.url === `${GENS}?ids=gen_aaaa1111,gen_missing1`));

  const c = await freshFast(dir, ['generate', 'cancel', 'gen_aaaa1111']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /gen_aaaa1111.*cancelled/);

  const open = await freshFast(dir, ['generate', 'list', '--open']);
  assert.equal(open.status, 0, open.stderr);
  assert.ok(mock.requests().some((q) => q.url === `${GENS}?status=open`));
  assert.match(open.stdout, /queued: 2 ahead/);

  const recent = await freshFast(dir, ['generate', 'list', '--limit', '5']);
  assert.ok(mock.requests().some((q) => q.url === `${GENS}?limit=5`));
  assert.match(recent.stdout, /gen_bbbb2222.*expired/);
});

test('gipity generate models lists GPU models with price, NSFW tag, availability and the queue estimate', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/generate/image/models', { body: { data: {
    models: [
      { id: 'flux-2-pro', provider: 'bfl' },
      { id: 'gipity-krea2-realistic', provider: 'gipity', label: 'Krea 2 Realistic', description: 'Photoreal, fast', async_only: true, nsfw: false, price_credits: 8, available: true, max_references: 0 },
      { id: 'gipity-krea2-nsfw', provider: 'gipity', label: 'Krea 2 NSFW', async_only: true, nsfw: true, price_credits: 8, available: true },
      { id: 'gipity-lustify', provider: 'gipity', async_only: true, nsfw: true, price_credits: null, available: false, unavailable_reason: 'not priced yet' },
    ],
    gipity_gpu: { online: true, queue: { paid_ahead: 1, free_ahead: 6 }, est_wait_s: { paid: 30, free: 240 } },
  } } });
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await freshFast(dir, ['generate', 'models']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /flux-2-pro\s+bfl/);
  assert.match(r.stdout, /Gipity GPU models \(queued, half the usual price\)/);
  assert.match(r.stdout, /1 paid \+ 6 free ahead; wait about 30s on a paid plan, about 4 min on Free/);
  assert.match(r.stdout, /gipity-krea2-realistic\s+8 credits/);
  assert.match(r.stdout, /gipity-krea2-nsfw\s+8 credits\s+NSFW/);
  assert.match(r.stdout, /gipity-lustify\s+not priced yet.*unavailable: not priced yet/);
  assert.doesNotMatch(r.stdout, /undefined/);

  const j = await freshFast(dir, ['generate', 'models', '--json']);
  assert.equal(JSON.parse(j.stdout).gipity_gpu.online, true);
});

test('generate help never names the GPU hardware or its software', async () => {
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  for (const args of [['generate', '--help'], ['generate', 'image', '--help'], ['generate', 'models', '--help']]) {
    const r = await freshFast(dir, args);
    assert.doesNotMatch(r.stdout + r.stderr, /GB10|DGX|ComfyUI|Ollama|Tailscale/i);
  }
});

// Real platform e2e for `gipity service call` and `page inspect|screenshot
// --fake-media`. Skipped unless GIPITY_E2E=1 is set. Verifies the live deploy,
// not a mock - mirrors the manual verification done when the feature shipped.
//
// Cost profile: ~$0.001 (one tiny LLM turn). Everything else is free CRUD +
// the browser pool. Uses dev-bypass auth (magic code 914914) with an `ec-`
// prefixed @914-6.com email so the platform suppresses real outbound mail.
//
// Env overrides:
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-sm@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-sm@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

// Probe page: call getUserMedia on load and log the outcome to the console.
// `page inspect` returns the console bundle, so the result is observable. With
// --fake-media Chrome gets a synthetic mic+cam and auto-grants the prompt, so
// this resolves; without it, headless Chrome has no real device and rejects.
const PROBE_MAIN_JS = `navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  .then(s => { console.log('MEDIA_OK audio=' + s.getAudioTracks().length + ' video=' + s.getVideoTracks().length); s.getTracks().forEach(t => t.stop()); })
  .catch(e => console.error('MEDIA_FAIL ' + e.name));
`;

describe('cli-e2e-services-media-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-sm-'));
  const projectSlug = `gip-e2e-sm-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };
  let appUrl = '';

  const cli = (args: string[], opts: { timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: projectDir, timeout: opts.timeout ?? 60000, enableUpdater: false,
    });

  before(() => {
    const login = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(login.status, 0, `login failed: ${login.stderr || login.stdout}`);

    const init = cli(['init', projectSlug]);
    assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);

    // web-simple gives us a deployable frontend; swap main.js for the probe.
    const add = cli(['add', 'web-simple']);
    assert.equal(add.status, 0, `add web-simple failed: ${add.stderr || add.stdout}`);
    writeFileSync(join(projectDir, 'src', 'js', 'main.js'), PROBE_MAIN_JS);

    const deploy = cli(['deploy', 'dev'], { timeout: 120000 });
    assert.equal(deploy.status, 0, `deploy failed: ${deploy.stderr || deploy.stdout}`);

    const status = JSON.parse(cli(['status', '--json']).stdout);
    appUrl = `https://dev.gipity.ai/${status.project.account}/${status.project.slug}/`;
  });

  after(() => {
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── service call ────────────────────────────────────────────────

  it('service call llm/models --get returns the model list (auth via session)', () => {
    const r = cli(['service', 'call', 'llm/models', '--get']);
    assert.equal(r.status, 0, `service call failed: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.ok(Array.isArray(body.data?.models) && body.data.models.length > 0, 'expected a non-empty models array');
  });

  it('service call llm <body> performs a real completion', () => {
    const r = cli(['service', 'call', 'llm', '{"prompt":"Reply with the single word: pong","max_tokens":16}'], { timeout: 60000 });
    assert.equal(r.status, 0, `service call llm failed: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.ok(Array.isArray(body.choices) && body.choices.length > 0, 'expected choices in the completion');
  });

  it('service call --get works on a multi-segment subpath (tts/voices)', () => {
    const r = cli(['service', 'call', 'tts/voices', '--get']);
    assert.equal(r.status, 0, `tts/voices failed: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.ok(Array.isArray(body.data?.voices), 'expected a voices array');
  });

  it('service call music/models --get lists models without leaking infra', () => {
    const r = cli(['service', 'call', 'music/models', '--get']);
    assert.equal(r.status, 0, `music/models failed: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    const models = body.data?.models;
    assert.ok(Array.isArray(models) && models.length > 0, 'expected a non-empty models array');
    const ids = models.map((m: { id: string }) => m.id);
    assert.ok(ids.includes('music-v1'), `expected music-v1 in ${JSON.stringify(ids)}`);
    assert.equal(body.data.default_model, 'music-v1', 'music-v1 should be the default');
    // ace-step (GPU model on the Modal backend) is enabled, so it's advertised too.
    assert.ok(ids.includes('ace-step'), `expected ace-step in ${JSON.stringify(ids)}`);
    // Every row advertises whether it can sing exact lyrics; both current models can.
    for (const m of models) {
      assert.equal(typeof m.supports_lyrics, 'boolean', `supports_lyrics missing on ${JSON.stringify(m)}`);
    }
    assert.ok(models.find((m: { id: string; supports_lyrics: boolean }) => m.id === 'music-v1')!.supports_lyrics,
      'music-v1 should advertise supports_lyrics');
    // `infra` is the hidden routing target and must never be returned to apps.
    for (const m of models) assert.ok(!('infra' in m), `infra leaked: ${JSON.stringify(m)}`);
  });

  it('service call music rejects lyrics + instrumental:true with a 400 (free)', () => {
    const r = cli(
      ['service', 'call', 'music', '{"prompt":"jazz","lyrics":"some words","instrumental":true}'],
    );
    assert.notEqual(r.status, 0, 'lyrics + instrumental:true must be rejected');
    assert.match(r.stderr || r.stdout, /instrumental/i, `expected the conflict named in the error, got: ${r.stderr || r.stdout}`);
  });

  it('service call music <body> generates a real clip (costs credits)', () => {
    const r = cli(
      ['service', 'call', 'music', '{"prompt":"short upbeat ukulele jingle","duration_seconds":5,"instrumental":true}'],
      { timeout: 120000 },
    );
    assert.equal(r.status, 0, `service call music failed: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.match(body.url ?? '', /^https?:\/\//, `expected a CDN url, got: ${r.stdout}`);
    assert.equal(body.model, 'music-v1', 'response should echo the resolved model');
    assert.ok(typeof body.credits_used === 'number' && body.credits_used > 0, 'expected credits_used > 0');
  });

  it('service call music model=ace-step sings caller lyrics on the GPU (Modal) backend', () => {
    // Lyrics instead of instrumental: same GPU spend, but this also exercises
    // supports_lyrics routing through the prod REST path end to end.
    const payload = '{"prompt":"mellow ambient synth pads, soft female vocals","duration_seconds":6,"lyrics":"[verse]\\nOne small lantern on the evening tide","model":"ace-step"}';
    // A COLD Modal container (boot + weight load) outlives the ~60s gateway
    // timeout, so the first request after idle can fail while the container
    // keeps warming (EasyClaw #455). Retry up to twice - each failed attempt
    // still advances the warm-up, and a warm render takes seconds. A warm
    // failure still fails the test; remove the retries when #455 is fixed.
    let r = cli(['service', 'call', 'music', payload], { timeout: 300000 });
    for (let attempt = 0; r.status !== 0 && attempt < 2; attempt++) {
      console.warn(`[e2e] ace-step attempt ${attempt + 1} failed (cold start? see EasyClaw #455) - retrying: ${(r.stderr || r.stdout).slice(0, 200)}`);
      r = cli(['service', 'call', 'music', payload], { timeout: 300000 });
    }
    assert.equal(r.status, 0, `ace-step music failed after retries: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.match(body.url ?? '', /^https?:\/\//, `expected a CDN url, got: ${r.stdout}`);
    assert.equal(body.model, 'ace-step', 'response should echo the ace-step model');
    assert.ok(typeof body.credits_used === 'number' && body.credits_used >= 10, 'ace-step bills at least its 10-credit floor');
  });

  it('generate music writes a real clip to disk (costs credits)', () => {
    const out = join(projectDir, 'gen-music.mp3');
    const r = cli(['generate', 'music', 'short upbeat ukulele jingle', '--duration', '5', '-o', out, '--json'], { timeout: 120000 });
    assert.equal(r.status, 0, `generate music failed: ${r.stderr || r.stdout}`);
    const meta = JSON.parse(r.stdout);
    assert.equal(meta.model, 'music-v1', 'expected the default model id in the result');
    assert.ok(existsSync(out) && statSync(out).size > 1000, `expected a non-empty mp3 at ${out}`);
  });

  it('generate music --lyrics-file sings caller lyrics end to end (costs credits)', () => {
    const lyricsPath = join(projectDir, 'e2e-lyrics.txt');
    writeFileSync(lyricsPath, '[Verse]\nGolden anchor on the harbor wall\n[Hook]\nSignal fire burning for the midnight call\n');
    const out = join(projectDir, 'gen-lyric-song.mp3');
    const r = cli(
      ['generate', 'music', 'slow acoustic folk, clear female vocals', '--lyrics-file', lyricsPath,
        '--duration', '12', '-o', out, '--json'],
      { timeout: 300000 },
    );
    assert.equal(r.status, 0, `generate music --lyrics-file failed: ${r.stderr || r.stdout}`);
    const meta = JSON.parse(r.stdout);
    assert.equal(meta.model, 'music-v1', 'lyrics should ride the default model');
    assert.equal(meta.duration_seconds, 12, 'requested duration should be honored in the result');
    assert.ok(typeof meta.credits_deducted === 'number' && meta.credits_deducted > 0, 'a lyric render costs credits');
    assert.ok(existsSync(out) && statSync(out).size > 10_000, `expected a non-trivial mp3 at ${out}`);
  });

  // Sound effects run against the DEFAULT billing config (user_pays) on a fresh
  // project: the logged-in owner is an identified payer, so no owner_pays flip
  // is ever needed to generate assets. Regression for the "temporary billing
  // flip" workaround agents invented when Bearer callers weren't recognized.

  it('service call sound generates a real clip under default user_pays billing (costs credits)', () => {
    const r = cli(
      ['service', 'call', 'sound', '{"text":"single cartoon boing","duration_seconds":1}'],
      { timeout: 120000 },
    );
    assert.equal(r.status, 0, `service call sound failed: ${r.stderr || r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.match(body.url ?? '', /^https?:\/\//, `expected a CDN url, got: ${r.stdout}`);
    assert.ok(typeof body.credits_used === 'number' && body.credits_used > 0, 'expected credits_used > 0');
  });

  it('generate sound writes a real clip to disk (costs credits)', () => {
    const out = join(projectDir, 'gen-sound.mp3');
    const r = cli(['generate', 'sound', 'cartoon character saying oof', '--duration', '1', '-o', out, '--json'], { timeout: 120000 });
    assert.equal(r.status, 0, `generate sound failed: ${r.stderr || r.stdout}`);
    const meta = JSON.parse(r.stdout);
    assert.match(meta.url ?? '', /^https?:\/\//, 'expected a CDN url in the result');
    assert.ok(existsSync(out) && statSync(out).size > 1000, `expected a non-empty mp3 at ${out}`);
  });

  it('service call rejects invalid JSON before hitting the network', () => {
    const r = cli(['service', 'call', 'llm', 'not-json']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not valid JSON/i);
  });

  it('service call surfaces an unknown service as an error (non-zero exit)', () => {
    const r = cli(['service', 'call', 'definitely-not-a-service', '{}']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not found/i);
  });

  // ── page inspect/screenshot --fake-media ────────────────────────

  it('page inspect grants a synthetic mic+cam by default (getUserMedia resolves)', () => {
    const r = cli(['page', 'inspect', appUrl, '--wait', '2500', '--json'], { timeout: 60000 });
    assert.equal(r.status, 0, `inspect failed: ${r.stderr || r.stdout}`);
    const bundle = JSON.parse(r.stdout);
    const consoleText = (bundle.console || []).join(' | ');
    assert.match(consoleText, /MEDIA_OK audio=[1-9]/, `expected MEDIA_OK, got: ${consoleText}`);
  });

  it('page inspect --no-fake-media has no media access (getUserMedia rejects)', () => {
    const r = cli(['page', 'inspect', appUrl, '--no-fake-media', '--wait', '2500', '--json'], { timeout: 60000 });
    assert.equal(r.status, 0, `inspect failed: ${r.stderr || r.stdout}`);
    const bundle = JSON.parse(r.stdout);
    const consoleText = (bundle.console || []).join(' | ');
    assert.doesNotMatch(consoleText, /MEDIA_OK/, `a camera was granted despite --no-fake-media: ${consoleText}`);
    assert.match(consoleText, /MEDIA_FAIL/, `expected MEDIA_FAIL, got: ${consoleText}`);
  });

  it('page screenshot --fake-media still produces a PNG', () => {
    const r = cli(['page', 'screenshot', appUrl, '--fake-media', '--wait', '2500', '--json'], { timeout: 60000 });
    assert.equal(r.status, 0, `screenshot failed: ${r.stderr || r.stdout}`);
    const meta = JSON.parse(r.stdout);
    assert.ok(meta.screenshots?.length >= 1 && meta.screenshots[0].width > 0, 'expected at least one non-empty screenshot');
  });
});

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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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

  it('page inspect --fake-media grants a synthetic mic+cam (getUserMedia resolves)', () => {
    const r = cli(['page', 'inspect', appUrl, '--fake-media', '--wait', '2500', '--json'], { timeout: 60000 });
    assert.equal(r.status, 0, `inspect failed: ${r.stderr || r.stdout}`);
    const bundle = JSON.parse(r.stdout);
    const consoleText = (bundle.console || []).join(' | ');
    assert.match(consoleText, /MEDIA_OK audio=[1-9]/, `expected MEDIA_OK, got: ${consoleText}`);
  });

  it('page inspect WITHOUT --fake-media has no media access (getUserMedia rejects)', () => {
    const r = cli(['page', 'inspect', appUrl, '--wait', '2500', '--json'], { timeout: 60000 });
    assert.equal(r.status, 0, `inspect failed: ${r.stderr || r.stdout}`);
    const bundle = JSON.parse(r.stdout);
    const consoleText = (bundle.console || []).join(' | ');
    assert.doesNotMatch(consoleText, /MEDIA_OK/, `fake media leaked into a normal call: ${consoleText}`);
    assert.match(consoleText, /MEDIA_FAIL/, `expected MEDIA_FAIL, got: ${consoleText}`);
  });

  it('page screenshot --fake-media still produces a PNG', () => {
    const r = cli(['page', 'screenshot', appUrl, '--fake-media', '--wait', '2500', '--json'], { timeout: 60000 });
    assert.equal(r.status, 0, `screenshot failed: ${r.stderr || r.stdout}`);
    const meta = JSON.parse(r.stdout);
    assert.ok(meta.screenshots?.length >= 1 && meta.screenshots[0].width > 0, 'expected at least one non-empty screenshot');
  });
});

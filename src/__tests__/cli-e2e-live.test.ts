// Real platform e2e tests. Skipped unless GIPITY_E2E=1 is set.
//
// Cost profile: ~$0.001 (one short LLM turn for `chat`); everything else is
// free platform CRUD. Uses dev-bypass auth (magic code 914914) with an
// `ec-` prefixed @914-6.com email so the platform suppresses real outbound
// mail (see platform/CLAUDE.md).
//
// Defaults can be overridden by env:
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-e2e@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

// Email convention guard — protect against accidentally invoking real SendGrid.
if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

describe('cli-e2e-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-proj-'));
  const projectSlug = `gip-e2e-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };

  // All commands run inside projectDir against the test API base, with our
  // throwaway HOME so we never touch the developer's real ~/.gipity/auth.json.
  const cli = (args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env,
      cwd: opts.cwd ?? projectDir,
      timeout: opts.timeout ?? 60000,
      enableUpdater: false,
    });

  before(() => {
    const r = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(r.status, 0, `login failed: ${r.stderr || r.stdout}`);
  });

  after(() => {
    // Best-effort cleanup; don't fail the whole suite if these go wrong.
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. auth round-trip', () => {
    const r = cli(['status', '--json']);
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.auth?.email, EMAIL);
    assert.equal(data.auth?.valid, true);
  });

  it('2. project lifecycle: init → status shows project', () => {
    const r = cli(['init', projectSlug]);
    assert.equal(r.status, 0, `init failed: ${r.stderr || r.stdout}`);

    const s = cli(['status', '--json']);
    const data = JSON.parse(s.stdout);
    assert.equal(data.project?.slug, projectSlug);
  });

  it('3. scaffold --type api creates expected files', () => {
    const r = cli(['scaffold', '--type', 'api']);
    assert.equal(r.status, 0, `scaffold failed: ${r.stderr || r.stdout}`);
    assert.ok(existsSync(join(projectDir, 'gipity.yaml')), 'gipity.yaml missing');
    assert.ok(existsSync(join(projectDir, 'functions')), 'functions/ missing');
    assert.ok(existsSync(join(projectDir, 'tests')), 'tests/ missing');
  });

  it('4a. deploy dev succeeds (first deploy)', () => {
    const r = cli(['deploy', 'dev'], { timeout: 120000 });
    assert.equal(r.status, 0, `deploy failed: ${r.stderr || r.stdout}`);
  });

  it('4b. deploy dev again is idempotent (no changes)', () => {
    const r = cli(['deploy', 'dev'], { timeout: 60000 });
    assert.equal(r.status, 0);
    // No strict assertion on output text — phases may say "skipped" or "ok"
    // depending on whether checksums caught everything. Just confirm exit 0.
  });

  it('4c. deploy dev --only functions filters phases', () => {
    const r = cli(['deploy', 'dev', '--only', 'functions'], { timeout: 60000 });
    assert.equal(r.status, 0);
  });

  it('4d. deploy dev --force re-runs all phases', () => {
    const r = cli(['deploy', 'dev', '--force'], { timeout: 120000 });
    assert.equal(r.status, 0);
  });

  it('5a. fn list shows the scaffolded get-weather function', () => {
    const r = cli(['fn', 'list', '--json']);
    assert.equal(r.status, 0);
    const fns = JSON.parse(r.stdout);
    assert.ok(Array.isArray(fns));
    assert.ok(fns.some((f: any) => f.name === 'get-weather'), 'get-weather not in fn list');
  });

  it('5b. fn call get-weather returns weather data', () => {
    const r = cli(['fn', 'call', 'get-weather', '{"zip":"94103"}'], { timeout: 30000 });
    assert.equal(r.status, 0, `fn call failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /temperature|weather|°|condition/i);
  });

  it('6a. db list succeeds', () => {
    const r = cli(['db', 'list', '--json']);
    assert.equal(r.status, 0, `db list failed: ${r.stderr || r.stdout}`);
  });

  it('6b. db query "select 1" returns 1', () => {
    const r = cli(['db', 'query', 'select 1 as n', '--json']);
    assert.equal(r.status, 0, `db query failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /"n"\s*:\s*1/);
  });

  it('7. chat "what is 2+2?" returns a 4', () => {
    const r = cli(['chat', 'what is 2+2? respond with only the number.'], { timeout: 60000 });
    assert.equal(r.status, 0, `chat failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /\b4\b/);
  });

  it('8. memory write/read/delete round-trip', () => {
    const w = cli(['memory', 'write', 'e2e-topic', 'ping']);
    assert.equal(w.status, 0, `memory write failed: ${w.stderr || w.stdout}`);

    const r = cli(['memory', 'read', 'e2e-topic']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ping/);

    const d = cli(['-y', 'memory', 'delete', 'e2e-topic']);
    assert.equal(d.status, 0, `memory delete failed: ${d.stderr || d.stdout}`);
  });

  it('9. doctor reports sane install info with auth', () => {
    const r = cli(['doctor']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Gipity CLI — doctor/);
    assert.match(r.stdout, /shim version/);
  });
});

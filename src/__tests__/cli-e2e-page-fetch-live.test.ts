// Real platform e2e for `gipity page fetch`. Skipped unless GIPITY_E2E=1.
//
// Proves the command end-to-end against live static hosting: it deploys a real
// web-simple app with a known llms.txt, then verifies that
//   - a deployed file reads back as OK, and
//   - a file that was never deployed reads back as MISSING — NOT a false 200.
// The second case is the whole reason the command exists: static hosting serves
// index.html for unknown paths, so a bare status check would pass on a file that
// isn't there. A naive `curl -o /dev/null -w '%{http_code}'` would print 200.
//
// Cost profile: free platform CRUD + one static deploy (no LLM tokens). Uses
// dev-bypass auth (magic code 914914) with an `ec-` prefixed @914-6.com email so
// the platform suppresses real outbound mail (see platform/CLAUDE.md).
//
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-e2e@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

// A marker we can assert is actually in the served body, proving it's the real
// file and not the SPA shell.
const LLMS_MARKER = 'gipity-page-fetch-e2e-marker';

describe('cli-e2e-page-fetch-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-fetch-'));
  const projectSlug = `gip-e2e-fetch-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };
  let appUrl = '';

  const cli = (args: string[], opts: { timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env,
      cwd: projectDir,
      timeout: opts.timeout ?? 60000,
      enableUpdater: false,
    });

  before(() => {
    const r = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(r.status, 0, `login failed: ${r.stderr || r.stdout}`);
  });

  after(() => {
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. scaffolds a static web-simple app and injects a known llms.txt', () => {
    const init = cli(['init', projectSlug]);
    assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);

    const add = cli(['add', 'web-simple'], { timeout: 120000 });
    assert.equal(add.status, 0, `add web-simple failed: ${add.stderr || add.stdout}`);

    const srcDir = join(projectDir, 'src');
    assert.ok(existsSync(srcDir), 'web-simple did not produce a local src/ directory');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'llms.txt'), `# llms.txt\n${LLMS_MARKER}\n`);
  });

  it('2. deploys to dev and captures the live URL', () => {
    const r = cli(['deploy', 'dev', '--json'], { timeout: 120000 });
    assert.equal(r.status, 0, `deploy failed: ${r.stderr || r.stdout}`);
    const data = JSON.parse(r.stdout) as { url?: string };
    assert.ok(data.url && /^https?:\/\//.test(data.url), `deploy did not return a url: ${r.stdout}`);
    appUrl = data.url;
  });

  it('3. page fetch reports OK for the deployed llms.txt', () => {
    const r = cli(['page', 'fetch', appUrl, 'llms.txt', '--json'], { timeout: 30000 });
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr || r.stdout}`);
    const out = JSON.parse(r.stdout) as { ok: boolean; files: { path: string; verdict: string; bytes: number }[] };
    assert.equal(out.ok, true, `expected ok=true: ${r.stdout}`);
    const f = out.files.find((x) => x.path === 'llms.txt');
    assert.ok(f, 'llms.txt missing from results');
    assert.equal(f!.verdict, 'OK');
    assert.ok(f!.bytes > 0, 'llms.txt came back empty');
  });

  it('4. page fetch reports MISSING for a file that was never deployed (not a false 200)', () => {
    const r = cli(['page', 'fetch', appUrl, 'definitely-not-deployed-xyz.json', '--json'], { timeout: 30000 });
    assert.notEqual(r.status, 0, `expected non-zero exit: ${r.stdout}`);
    const out = JSON.parse(r.stdout) as { ok: boolean; files: { path: string; verdict: string }[] };
    assert.equal(out.ok, false);
    const f = out.files.find((x) => x.path === 'definitely-not-deployed-xyz.json');
    assert.ok(f, 'result missing from output');
    assert.equal(f!.verdict, 'MISSING', `a missing file must not read as present: ${r.stdout}`);
  });

  it('5. page fetch handles a mixed batch: present OK, absent MISSING, overall failure', () => {
    const r = cli(['page', 'fetch', appUrl, 'llms.txt', 'nope-missing.txt', '--json'], { timeout: 30000 });
    assert.notEqual(r.status, 0);
    const out = JSON.parse(r.stdout) as { ok: boolean; failed: number; files: { path: string; verdict: string }[] };
    assert.equal(out.ok, false);
    assert.equal(out.failed, 1);
    const byPath = Object.fromEntries(out.files.map((f) => [f.path, f.verdict]));
    assert.equal(byPath['llms.txt'], 'OK');
    assert.equal(byPath['nope-missing.txt'], 'MISSING');
  });
});

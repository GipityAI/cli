// Real platform e2e tests for FILE SYNC. Skipped unless GIPITY_E2E=1.
//
// This exercises the actual sync round-trip against production with real files:
// publish → pull into a fresh folder → re-sync noop → modify/propagate →
// delete/propagate, plus the diabolical mixed-folder MERGE cases that motivated
// WS-00253 (a populated folder synced into an existing project). Everything here
// is free platform file CRUD - no LLM, no media.
//
// Why two dirs: a project's files live on the server. We link dirA (the author)
// and dirB/dirC (fresh checkouts) to the SAME project by copying .gipity.json,
// then drive sync between them - exactly how two machines share a project.
//
//   GIPITY_E2E=1                  enable
//   GIPITY_E2E_API_BASE=...       default https://a.gipity.ai (production)
//   GIPITY_E2E_EMAIL=ec-cli-e2e-sync@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync,
  mkdirSync, copyFileSync, readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e-sync@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

describe('cli-e2e-sync-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const dirA = mkdtempSync(join(tmpdir(), 'gipity-sync-A-'));  // author
  const dirB = mkdtempSync(join(tmpdir(), 'gipity-sync-B-'));  // fresh pull
  const dirC = mkdtempSync(join(tmpdir(), 'gipity-sync-C-'));  // mixed/diabolical
  const projectSlug = `gip-e2e-sync-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };

  const cli = (args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: opts.cwd ?? dirA, timeout: opts.timeout ?? 90000, enableUpdater: false,
    });

  // Link a fresh directory to the same project by copying its config (no
  // baseline → a first sync there is a clean pull / or a guarded merge).
  const linkDir = (dir: string) => copyFileSync(join(dirA, '.gipity.json'), join(dir, '.gipity.json'));

  const planOf = (cwd: string, extra: string[] = []) => {
    const r = cli(['sync', '--plan', '--json', ...extra], { cwd });
    assert.equal(r.status, 0, `sync --plan failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  };

  before(() => {
    const r = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(r.status, 0, `login failed: ${r.stderr || r.stdout}`);
    const i = cli(['init', projectSlug]);
    assert.equal(i.status, 0, `init failed: ${i.stderr || i.stdout}`);
  });

  after(() => {
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    for (const d of [dirA, dirB, dirC, tmpHome]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('1. publish: a brand-new project (empty server) uploads local files with NO merge prompt', () => {
    // Real files incl. nested dirs and a "binary" with non-text bytes.
    mkdirSync(join(dirA, 'src'), { recursive: true });
    writeFileSync(join(dirA, 'src', 'index.html'), '<!doctype html><h1>hello</h1>\n');
    writeFileSync(join(dirA, 'src', 'app.js'), 'console.log("v1");\n');
    writeFileSync(join(dirA, 'readme.md'), '# Sync E2E\n');
    writeFileSync(join(dirA, 'data.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 128, 42]));

    // Server is empty → this is a publish, not a merge. No -y needed; must not abort.
    const r = cli(['sync'], { cwd: dirA });
    assert.equal(r.status, 0, `publish sync failed/aborted: ${r.stderr || r.stdout}`);

    const plan = planOf(dirA);
    assert.equal(plan.plan.uploads, 0, 're-plan after publish shows nothing left to upload');
  });

  it('2. pull: a fresh empty folder downloads the whole project, byte-for-byte', () => {
    linkDir(dirB);
    const r = cli(['sync'], { cwd: dirB });
    assert.equal(r.status, 0, `pull failed: ${r.stderr || r.stdout}`);

    // Every authored file arrived with identical content (incl. nested + binary).
    assert.equal(readFileSync(join(dirB, 'src', 'index.html'), 'utf-8'), readFileSync(join(dirA, 'src', 'index.html'), 'utf-8'));
    assert.equal(readFileSync(join(dirB, 'src', 'app.js'), 'utf-8'), 'console.log("v1");\n');
    assert.deepEqual(readFileSync(join(dirB, 'data.bin')), readFileSync(join(dirA, 'data.bin')), 'binary file round-trips byte-for-byte');
  });

  it('3. re-sync of a clean checkout is a noop (no actions, no conflict copies)', () => {
    const plan = planOf(dirB);
    assert.equal(plan.plan.uploads, 0);
    assert.equal(plan.plan.downloads, 0);
    assert.equal(plan.plan.conflicts, 0);
    // No stray "(conflict from ...)" files were minted.
    assert.ok(!readdirSync(join(dirB, 'src')).some(n => n.includes('conflict from')), 'no conflict copies on a clean re-sync');
  });

  it('4. mixed folder + non-interactive sync ABORTS (exit 1), moving nothing', () => {
    // dirC has its own local-only file AND a file that collides with the server
    // at a different content - a real two-way merge.
    linkDir(dirC);
    writeFileSync(join(dirC, 'my-notes.txt'), 'local only, not in project\n');
    mkdirSync(join(dirC, 'src'), { recursive: true });
    writeFileSync(join(dirC, 'src', 'app.js'), 'console.log("LOCAL DIVERGENT");\n'); // collides w/ server app.js

    const r = cli(['sync'], { cwd: dirC });           // no -y, non-interactive
    assert.notEqual(r.status, 0, 'an unconfirmed merge must exit non-zero');
    assert.match(r.stdout + r.stderr, /haven't been synced|--yes/i, 'explains how to proceed');

    // Nothing moved: server file not pulled over our divergent copy, local-only intact.
    assert.equal(readFileSync(join(dirC, 'src', 'app.js'), 'utf-8'), 'console.log("LOCAL DIVERGENT");\n');
    assert.ok(!existsSync(join(dirC, 'readme.md')), 'no server files pulled into the aborted merge');
  });

  it('5. mixed folder + sync --yes MERGES: downloads, uploads local-only, conflict-copies the collision', () => {
    const r = cli(['sync', '-y'], { cwd: dirC });
    assert.equal(r.status, 0, `confirmed merge failed: ${r.stderr || r.stdout}`);

    // Server files now present locally; the canonical path holds the SERVER copy.
    assert.ok(existsSync(join(dirC, 'readme.md')), 'server file pulled in on confirmed merge');
    assert.equal(readFileSync(join(dirC, 'src', 'app.js'), 'utf-8'), 'console.log("v1");\n', 'server wins the canonical path');
    // The divergent local copy is preserved as a conflict file (both kept).
    assert.ok(readdirSync(join(dirC, 'src')).some(n => n.includes('conflict from')), 'divergent local copy kept as a conflict file');

    // The local-only file was uploaded INTO the project: a fresh pull sees it.
    const dirD = mkdtempSync(join(tmpdir(), 'gipity-sync-D-'));
    linkDir(dirD);
    const pr = cli(['sync'], { cwd: dirD });
    assert.equal(pr.status, 0, `verify-pull failed: ${pr.stderr || pr.stdout}`);
    assert.ok(existsSync(join(dirD, 'my-notes.txt')), 'local-only file became part of the project');
    rmSync(dirD, { recursive: true, force: true });
  });

  it('6. modify propagates: edit in dirA, sync, then dirB pulls the new bytes', () => {
    writeFileSync(join(dirA, 'src', 'app.js'), 'console.log("v2-edited");\n');
    const up = cli(['sync', '-y'], { cwd: dirA });
    assert.equal(up.status, 0, `modify upload failed: ${up.stderr || up.stdout}`);

    const down = cli(['sync', '-y'], { cwd: dirB });
    assert.equal(down.status, 0, `modify download failed: ${down.stderr || down.stdout}`);
    assert.equal(readFileSync(join(dirB, 'src', 'app.js'), 'utf-8'), 'console.log("v2-edited");\n', 'edit propagated through the server');
  });

  it('7. delete propagates: remove in dirA + --prune, then dirB pulls the deletion', () => {
    rmSync(join(dirA, 'readme.md'));
    // Single delete is below the bulk-guard threshold, but --prune is explicit.
    const up = cli(['sync', '--prune', '-y'], { cwd: dirA });
    assert.equal(up.status, 0, `delete upload failed: ${up.stderr || up.stdout}`);

    const down = cli(['sync', '-y'], { cwd: dirB });
    assert.equal(down.status, 0, `delete download failed: ${down.stderr || down.stdout}`);
    assert.ok(!existsSync(join(dirB, 'readme.md')), 'deletion propagated through the server');
  });
});

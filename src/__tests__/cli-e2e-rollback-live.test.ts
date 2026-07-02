// Real platform e2e tests for ROLLBACK + version history. Skipped unless GIPITY_E2E=1.
//
// The promise the user cares about most: "we should ALWAYS be able to reliably
// roll back, and never lose data." This suite proves that end-to-end against a
// real server using the real `gipity file rollback` / `file restore` / `file
// versions` commands:
//
//   - roll back to a point in time restores the exact prior bytes, brings back a
//     file that was deleted after T, and removes a file created after T
//   - roll FORWARD ("latest") restores everything to its newest content,
//     including files a prior rollback had removed (version history is immutable
//     - nothing is ever destroyed)
//   - single-file version restore flips a file between versions byte-exactly
//   - a rollback → forward → rollback cycle never corrupts or loses the file
//   - path-scoped rollback leaves files outside the scope untouched
//
// Timestamps are anchored to SERVER time (read back from `file versions`), never
// the client clock, so the assertions don't depend on client/server clock skew.
//
//   GIPITY_E2E=1                  enable
//   GIPITY_E2E_API_BASE=...       default https://a.gipity.ai (production)
//   GIPITY_E2E_EMAIL=ec-cli-e2e-sync@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync,
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

describe('cli-e2e-rollback-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const dirA = mkdtempSync(join(tmpdir(), 'gip-rb-A-'));  // author
  const projectSlug = `gip-e2e-rb-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };
  const created: string[] = [dirA, tmpHome];

  const cli = (args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: opts.cwd ?? dirA, timeout: opts.timeout ?? 120000, enableUpdater: false,
    });

  /** A fresh checkout of the SAME project — the clean way to observe server state
   *  after a rollback without any local-baseline divergence noise. */
  const freshCheckout = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gip-rb-chk-'));
    created.push(dir);
    copyFileSync(join(dirA, '.gipity.json'), join(dir, '.gipity.json'));
    const r = cli(['sync', '-y'], { cwd: dir });
    assert.equal(r.status, 0, `fresh checkout pull failed: ${r.stderr || r.stdout}`);
    return dir;
  };

  /** Server-side created_at (ISO) of a specific version of a path. */
  const versionTime = (path: string, versionNum: number): number => {
    const r = cli(['file', 'versions', path, '--json']);
    assert.equal(r.status, 0, `versions failed: ${r.stderr || r.stdout}`);
    const versions = JSON.parse(r.stdout) as Array<{ version: number; created_at: string }>;
    const v = versions.find(x => x.version === versionNum);
    assert.ok(v, `version ${versionNum} of ${path} not found in ${r.stdout}`);
    return new Date(v!.created_at).getTime();
  };

  const rollback = (datetime: string, extra: string[] = []) => {
    const r = cli(['file', 'rollback', datetime, '--json', ...extra]);
    assert.equal(r.status, 0, `rollback failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout) as { filesRestored: number; filesRemoved: number; dirsRestored: number; dirsRemoved: number; filesUnchanged: number };
  };

  before(() => {
    assert.equal(cli(['login', '--email', EMAIL, '--code', CODE]).status, 0, 'login');
    assert.equal(cli(['init', projectSlug]).status, 0, 'init');
  });

  after(() => {
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    for (const d of created) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('1. point-in-time rollback: restores exact prior bytes, brings back a deleted file, removes a file created after T', async () => {
    // Phase 1 — the state we will roll back TO.
    writeFileSync(join(dirA, 'a.txt'), 'A-version-1\n');
    writeFileSync(join(dirA, 'b.txt'), 'B-original\n');
    assert.equal(cli(['sync', '-y']).status, 0);
    const t1 = versionTime('a.txt', 1);      // server time of phase 1

    await sleep(2500); // ensure phase-2 writes land at a clearly later server time

    // Phase 2 — edit a, delete b, add c.
    writeFileSync(join(dirA, 'a.txt'), 'A-version-2\n');
    rmSync(join(dirA, 'b.txt'));
    writeFileSync(join(dirA, 'c.txt'), 'C-new\n');
    assert.equal(cli(['sync', '--prune', '-y']).status, 0);

    // Roll back to ~1s after phase 1 (well before phase 2).
    const target = new Date(t1 + 1000).toISOString();
    const rb = rollback(target);
    assert.ok(rb.filesRestored >= 1, `restored a.txt (→v1) and b.txt (undeleted): ${JSON.stringify(rb)}`);
    assert.ok(rb.filesRemoved >= 1, `removed c.txt created after T: ${JSON.stringify(rb)}`);

    // Observe the rolled-back server state via a clean checkout.
    const chk = freshCheckout();
    assert.equal(readFileSync(join(chk, 'a.txt'), 'utf-8'), 'A-version-1\n', 'a.txt restored to its exact v1 bytes');
    assert.ok(existsSync(join(chk, 'b.txt')), 'b.txt (deleted after T) was brought back');
    assert.equal(readFileSync(join(chk, 'b.txt'), 'utf-8'), 'B-original\n', 'b.txt restored to its exact bytes');
    assert.ok(!existsSync(join(chk, 'c.txt')), 'c.txt (created after T) was removed');
  });

  it('2. roll FORWARD (latest): restores everything to newest content — deletions are recoverable, history is never lost', () => {
    const rb = rollback('latest');
    assert.ok(rb.filesRestored >= 1, `roll-forward restores files: ${JSON.stringify(rb)}`);

    const chk = freshCheckout();
    // a.txt back to its newest bytes; b and c — which the point-in-time rollback
    // had (respectively) kept and removed — are both recoverable to their newest
    // versions, because version history is immutable and nothing was destroyed.
    assert.equal(readFileSync(join(chk, 'a.txt'), 'utf-8'), 'A-version-2\n', 'a.txt rolled forward to v2');
    assert.equal(readFileSync(join(chk, 'c.txt'), 'utf-8'), 'C-new\n', 'c.txt recovered on roll-forward (never truly lost)');
  });

  it('3. single-file version restore flips a file between versions byte-exactly', () => {
    // a.txt has v1 (A-version-1) and v2 (A-version-2). Flip to v1, then back.
    const r1 = cli(['file', 'restore', 'a.txt', '1', '--json']);
    assert.equal(r1.status, 0, `restore v1 failed: ${r1.stderr || r1.stdout}`);
    assert.equal(cli(['file', 'cat', 'a.txt']).stdout, 'A-version-1\n', 'restored to v1 content');

    const r2 = cli(['file', 'restore', 'a.txt', '2', '--json']);
    assert.equal(r2.status, 0, `restore v2 failed: ${r2.stderr || r2.stdout}`);
    assert.equal(cli(['file', 'cat', 'a.txt']).stdout, 'A-version-2\n', 'restored to v2 content');
  });

  it('4. rollback → forward → rollback cycle never corrupts or loses the file, and stays scoped', async () => {
    mkdirSync(join(dirA, 'cyc'), { recursive: true });
    writeFileSync(join(dirA, 'cyc', 'x.txt'), 'cycle-hello\n');
    writeFileSync(join(dirA, 'outside.txt'), 'do not touch\n');
    assert.equal(cli(['sync', '-y']).status, 0);
    const tc = versionTime('cyc/x.txt', 1);
    const before = new Date(tc - 3000).toISOString(); // a moment before cyc/x.txt existed

    for (let cycle = 0; cycle < 2; cycle++) {
      // Scoped rollback to before creation → the file is removed, scope-limited.
      const rbOut = rollback(before, ['--path', 'cyc']);
      assert.ok(rbOut.filesRemoved >= 1, `cycle ${cycle}: scoped rollback removed cyc/x.txt: ${JSON.stringify(rbOut)}`);
      let chk = freshCheckout();
      assert.ok(!existsSync(join(chk, 'cyc', 'x.txt')), `cycle ${cycle}: cyc/x.txt removed`);
      assert.ok(existsSync(join(chk, 'outside.txt')), `cycle ${cycle}: out-of-scope file untouched by scoped rollback`);

      // Roll forward → the file returns, byte-exact. Never lost.
      const rbFwd = rollback('latest', ['--path', 'cyc']);
      assert.ok(rbFwd.filesRestored >= 1, `cycle ${cycle}: roll-forward restored cyc/x.txt: ${JSON.stringify(rbFwd)}`);
      chk = freshCheckout();
      assert.equal(readFileSync(join(chk, 'cyc', 'x.txt'), 'utf-8'), 'cycle-hello\n', `cycle ${cycle}: cyc/x.txt recovered byte-exact`);
    }

    await sleep(100);
  });
});

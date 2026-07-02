// Real platform e2e STRESS tests for FILE SYNC. Skipped unless GIPITY_E2E=1.
//
// The companion to cli-e2e-sync-live: that one covers the happy-path round-trip
// and the mixed-folder merge. THIS one is adversarial — it tries to lose data.
// Every scenario that motivated the sync-integrity audit is exercised end-to-end
// against a real deployed server with the real CLI client:
//
//   - folder move / rename propagation (a move is a delete+add under the hood)
//   - folder edits (add a file, remove a file, from inside a synced dir)
//   - delete-then-recreate of the SAME path (a fresh server node at version 1 -
//     must still propagate to a checkout that saw the old node)
//   - concurrent divergent edits on two machines (conflict copy keeps BOTH)
//   - the bulk-delete guard (a mass local delete must NOT wipe the server)
//   - .gipityignore ("unsync": ignored files never upload and are never deleted)
//   - byte-exact binary + deep-nested integrity
//   - empty-out then repopulate a folder
//
// The invariant under test is the one the user cares about: sync never silently
// loses a byte. When two sides disagree, both copies survive (one as a conflict
// file); a mass delete is guarded; ignored files are untouched.
//
//   GIPITY_E2E=1                  enable
//   GIPITY_E2E_API_BASE=...       default https://a.gipity.ai (production)
//   GIPITY_E2E_EMAIL=ec-cli-e2e-sync@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync,
  mkdirSync, copyFileSync, readdirSync, renameSync,
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

describe('cli-e2e-sync-stress-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const dirA = mkdtempSync(join(tmpdir(), 'gip-stress-A-'));  // author
  const projectSlug = `gip-e2e-stress-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };
  const created: string[] = [dirA, tmpHome];

  const cli = (args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: opts.cwd ?? dirA, timeout: opts.timeout ?? 120000, enableUpdater: false,
    });

  /** A fresh checkout of the SAME project (empty baseline → clean pull). */
  const freshCheckout = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gip-stress-chk-'));
    created.push(dir);
    copyFileSync(join(dirA, '.gipity.json'), join(dir, '.gipity.json'));
    const r = cli(['sync', '-y'], { cwd: dir });
    assert.equal(r.status, 0, `fresh checkout pull failed: ${r.stderr || r.stdout}`);
    return dir;
  };

  const syncJson = (cwd: string, extra: string[] = []) => {
    const r = cli(['sync', '--json', ...extra], { cwd });
    // A deferred bulk-delete is exit 0; a refused merge / error is exit 1.
    return { status: r.status, result: r.stdout.trim() ? JSON.parse(r.stdout) : null, raw: r.stdout + r.stderr };
  };

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
    for (const d of created) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('1. folder move/rename: mv a populated folder, sync --prune, files land at the new path byte-for-byte and the old path is gone', () => {
    mkdirSync(join(dirA, 'foo', 'sub'), { recursive: true });
    writeFileSync(join(dirA, 'foo', 'a.txt'), 'alpha\n');
    writeFileSync(join(dirA, 'foo', 'sub', 'b.txt'), 'bravo\n');
    writeFileSync(join(dirA, 'keep.txt'), 'keep\n');
    assert.equal(cli(['sync', '-y']).status, 0);

    // Move the whole folder locally, then propagate.
    renameSync(join(dirA, 'foo'), join(dirA, 'bar'));
    const mv = cli(['sync', '--prune', '-y']);
    assert.equal(mv.status, 0, `folder move sync failed: ${mv.stderr || mv.stdout}`);

    const chk = freshCheckout();
    assert.equal(readFileSync(join(chk, 'bar', 'a.txt'), 'utf-8'), 'alpha\n', 'moved file content preserved');
    assert.equal(readFileSync(join(chk, 'bar', 'sub', 'b.txt'), 'utf-8'), 'bravo\n', 'nested moved file preserved');
    assert.ok(!existsSync(join(chk, 'foo')), 'old folder path removed on the server');
    assert.ok(existsSync(join(chk, 'keep.txt')), 'unrelated file untouched by the move');
  });

  it('2. folder edit: add one file and remove another inside a synced folder, both propagate', () => {
    writeFileSync(join(dirA, 'bar', 'c.txt'), 'charlie\n');   // add
    rmSync(join(dirA, 'bar', 'a.txt'));                        // remove
    const r = cli(['sync', '--prune', '-y']);
    assert.equal(r.status, 0, `folder edit sync failed: ${r.stderr || r.stdout}`);

    const chk = freshCheckout();
    assert.equal(readFileSync(join(chk, 'bar', 'c.txt'), 'utf-8'), 'charlie\n', 'added file propagated');
    assert.ok(!existsSync(join(chk, 'bar', 'a.txt')), 'removed file propagated');
    assert.equal(readFileSync(join(chk, 'bar', 'sub', 'b.txt'), 'utf-8'), 'bravo\n', 'sibling untouched');
  });

  it('3. delete-then-recreate the SAME path: a stale checkout that saw the old content must pull the NEW content', () => {
    // A second machine that has the ORIGINAL content, fully synced.
    writeFileSync(join(dirA, 'recreate.txt'), 'ORIGINAL\n');
    assert.equal(cli(['sync', '-y']).status, 0);
    const other = freshCheckout();
    assert.equal(readFileSync(join(other, 'recreate.txt'), 'utf-8'), 'ORIGINAL\n');

    // Author deletes it, then recreates it at the same path with new bytes. The
    // server makes a brand-new node whose version counter restarts at 1 - the bug
    // was that a checkout at a higher baseline counter skipped this forever.
    rmSync(join(dirA, 'recreate.txt'));
    assert.equal(cli(['sync', '--prune', '-y']).status, 0);
    writeFileSync(join(dirA, 'recreate.txt'), 'REBORN\n');
    assert.equal(cli(['sync', '-y']).status, 0);

    // The stale checkout must converge to REBORN, not stay stuck on ORIGINAL.
    const down = cli(['sync', '-y'], { cwd: other });
    assert.equal(down.status, 0, `recreate pull failed: ${down.stderr || down.stdout}`);
    assert.equal(readFileSync(join(other, 'recreate.txt'), 'utf-8'), 'REBORN\n', 'delete+recreate propagated to the stale checkout');
  });

  it('4. concurrent divergent edits: two machines edit the same file without pulling — the loser is kept as a conflict copy, nothing is lost', () => {
    writeFileSync(join(dirA, 'shared.txt'), 'base\n');
    assert.equal(cli(['sync', '-y']).status, 0);
    const machineB = freshCheckout();
    assert.equal(readFileSync(join(machineB, 'shared.txt'), 'utf-8'), 'base\n');

    // A advances the server.
    writeFileSync(join(dirA, 'shared.txt'), 'EDIT-FROM-A\n');
    assert.equal(cli(['sync', '-y']).status, 0);

    // B edits its stale copy and syncs WITHOUT pulling first → CAS conflict.
    writeFileSync(join(machineB, 'shared.txt'), 'EDIT-FROM-B\n');
    const r = cli(['sync', '-y'], { cwd: machineB });
    assert.equal(r.status, 0, `conflicting sync should resolve, not fail: ${r.stderr || r.stdout}`);

    // Canonical path holds the server's copy (A wins); B's edit survives as a
    // conflict file. BOTH byte-sequences still exist on disk — zero data loss.
    assert.equal(readFileSync(join(machineB, 'shared.txt'), 'utf-8'), 'EDIT-FROM-A\n', 'server copy wins the canonical path');
    const conflictFiles = readdirSync(machineB).filter(n => n.includes('conflict') && n.endsWith('.txt'));
    assert.ok(conflictFiles.length >= 1, 'the divergent local edit was preserved as a conflict copy');
    const conflictBody = readFileSync(join(machineB, conflictFiles[0]), 'utf-8');
    assert.equal(conflictBody, 'EDIT-FROM-B\n', 'the conflict copy holds the exact losing bytes');
  });

  it('5. bulk-delete guard: deleting the whole tree locally must NOT wipe the server without --prune', () => {
    // Fresh, self-contained project area with enough files to trip the guard
    // (>=10 deletes AND >=25% of the tree).
    const bulkDir = join(dirA, 'bulk');
    mkdirSync(bulkDir, { recursive: true });
    for (let i = 0; i < 14; i++) writeFileSync(join(bulkDir, `f${i}.txt`), `file ${i}\n`);
    assert.equal(cli(['sync', '-y']).status, 0);

    // Delete them all locally, then a plain non-interactive sync (no --prune).
    for (let i = 0; i < 14; i++) rmSync(join(bulkDir, `f${i}.txt`));
    const guarded = syncJson(dirA);
    assert.equal(guarded.status, 0, 'a guarded (deferred) delete is not an error');
    assert.ok(guarded.result.deferredDeletes >= 10, `the mass delete was deferred by the guard, not applied (got ${guarded.result?.deferredDeletes})`);

    // The server still has every file — a fresh checkout pulls them all back.
    const chk = freshCheckout();
    for (let i = 0; i < 14; i++) {
      assert.ok(existsSync(join(chk, 'bulk', `f${i}.txt`)), `guarded file f${i}.txt survived on the server`);
    }

    // With the explicit --prune, the deletes finally apply.
    const pruned = cli(['sync', '--prune', '-y']);
    assert.equal(pruned.status, 0, `prune failed: ${pruned.stderr || pruned.stdout}`);
    const chk2 = freshCheckout();
    assert.ok(!existsSync(join(chk2, 'bulk')), 'explicit --prune removed the folder on the server');
  });

  it('6. .gipityignore "unsync": ignored files never upload and are never deleted locally', () => {
    writeFileSync(join(dirA, '.gipityignore'), 'ignored.log\nsecret/\n');
    writeFileSync(join(dirA, 'ignored.log'), 'do not sync me\n');
    mkdirSync(join(dirA, 'secret'), { recursive: true });
    writeFileSync(join(dirA, 'secret', 'keys.txt'), 'top secret\n');
    writeFileSync(join(dirA, 'tracked.txt'), 'sync me\n');

    const r = cli(['sync', '-y']);
    assert.equal(r.status, 0, `ignore sync failed: ${r.stderr || r.stdout}`);

    // Ignored paths are invisible to a fresh checkout; tracked file is present.
    const chk = freshCheckout();
    assert.ok(existsSync(join(chk, 'tracked.txt')), 'tracked file uploaded');
    assert.ok(!existsSync(join(chk, 'ignored.log')), 'ignored file was NOT uploaded');
    assert.ok(!existsSync(join(chk, 'secret')), 'ignored folder was NOT uploaded');
    // The local ignored files are still on disk (unsync ≠ delete).
    assert.ok(existsSync(join(dirA, 'ignored.log')), 'ignored file left on disk locally');
    assert.ok(existsSync(join(dirA, 'secret', 'keys.txt')), 'ignored folder left on disk locally');
  });

  it('7. binary + deep nesting: bytes round-trip exactly through publish → pull', () => {
    const deep = join(dirA, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 128, 42, 13, 10, 0, 7]);
    writeFileSync(join(deep, 'blob.bin'), bytes);
    assert.equal(cli(['sync', '-y']).status, 0);

    const chk = freshCheckout();
    assert.deepEqual(readFileSync(join(chk, 'a', 'b', 'c', 'd', 'e', 'blob.bin')), bytes, 'deep-nested binary is byte-for-byte identical');
  });

  it('8. clean re-sync is a stable noop (no phantom uploads/downloads/conflicts)', () => {
    const plan = planOf(dirA);
    assert.equal(plan.plan.uploads, 0, 'nothing left to upload');
    assert.equal(plan.plan.downloads, 0, 'nothing left to download');
    assert.equal(plan.plan.conflicts, 0, 'no phantom conflicts on a settled tree');
  });
});

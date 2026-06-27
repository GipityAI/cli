/**
 * Crash-safe capture hook lock (`~/.gipity/capture-state/<conv>.lock`) -
 * serializes concurrent capture-runner invocations for one conversation and,
 * critically, reclaims a lock stranded by a crashed/SIGKILL'd hook instead of
 * silently disabling capture for that conversation forever. Mirrors the
 * advisory lock semantics in sync.ts.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// CAPTURE_DIR is computed from homedir() at module load, so point $HOME at a
// temp dir BEFORE importing the module under test (POSIX os.homedir() honors
// $HOME). The conversation guid keys the lock file name.
const CONV = 'cv_locktest';
let tempHome: string;
let captureDir: string;
let lockFile: string;
let originalHome: string | undefined;

before(() => {
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), 'gipity-capture-lock-'));
  process.env.HOME = tempHome;
  captureDir = join(tempHome, '.gipity', 'capture-state');
  lockFile = join(captureDir, `${CONV}.lock`);
  mkdirSync(captureDir, { recursive: true });
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(() => {
  try { rmSync(lockFile, { force: true }); } catch { /* */ }
});

/** Resolve a definitely-dead PID by forking a process that exits immediately. */
async function deadPidOf(): Promise<number> {
  const { execSync } = await import('child_process');
  const pid = parseInt(
    execSync('bash -c "(echo $$; exec sleep 0.01) & wait $!; echo $!"', { encoding: 'utf-8' })
      .split('\n').filter(Boolean).pop()!,
    10,
  );
  let tries = 20;
  while (tries-- > 0) {
    try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 10)); }
    catch { break; }
  }
  return pid;
}

describe('acquireLock', () => {
  it('creates the lock file with the current PID and removes it on release', async () => {
    const { acquireLock } = await import('../hooks/capture-runner.js');
    const release = acquireLock(CONV);
    assert.ok(release, 'should acquire on a free lock');
    assert.ok(existsSync(lockFile), 'lock file should exist');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release!();
    assert.ok(!existsSync(lockFile), 'release should remove the lock file');
  });

  it('release is idempotent', async () => {
    const { acquireLock } = await import('../hooks/capture-runner.js');
    const release = acquireLock(CONV)!;
    release();
    assert.ok(!existsSync(lockFile));
    release(); // must not throw
    assert.ok(!existsSync(lockFile));
  });

  it('returns null when a live holder owns the lock (skip, do not steal)', async () => {
    const { acquireLock } = await import('../hooks/capture-runner.js');
    // Our own (alive) PID with a just-written mtime = a live holder.
    writeFileSync(lockFile, String(process.pid));
    assert.equal(acquireLock(CONV), null, 'must not steal a live holder');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid, 'lock untouched');
  });

  it('reclaims a lock whose holder PID is dead', async () => {
    const { acquireLock } = await import('../hooks/capture-runner.js');
    writeFileSync(lockFile, String(await deadPidOf()));
    const release = acquireLock(CONV);
    assert.ok(release, 'should reclaim a dead holder');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release!();
  });

  it('reclaims an empty lock file (holder crashed before writing its PID)', async () => {
    const { acquireLock } = await import('../hooks/capture-runner.js');
    writeFileSync(lockFile, '');
    const release = acquireLock(CONV);
    assert.ok(release, 'empty lock = abandoned, must reclaim');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release!();
  });
});

describe('isLockReclaimable', () => {
  it('reclaims empty / garbage lock files', async () => {
    const { isLockReclaimable } = await import('../hooks/capture-runner.js');
    writeFileSync(lockFile, '');
    assert.equal(isLockReclaimable(lockFile), true, 'empty');
    writeFileSync(lockFile, 'not-a-pid');
    assert.equal(isLockReclaimable(lockFile), true, 'garbage');
  });

  it('does NOT reclaim a live holder with a fresh heartbeat', async () => {
    const { isLockReclaimable } = await import('../hooks/capture-runner.js');
    writeFileSync(lockFile, String(process.pid));
    assert.equal(isLockReclaimable(lockFile), false);
  });

  it('reclaims a live PID whose heartbeat went silent past the stale window', async () => {
    const { isLockReclaimable, LOCK_STALE_MS } = await import('../hooks/capture-runner.js');
    writeFileSync(lockFile, String(process.pid));
    const mtimeMs = statSync(lockFile).mtimeMs;
    assert.equal(isLockReclaimable(lockFile, mtimeMs + LOCK_STALE_MS + 1), true, 'past window');
    assert.equal(isLockReclaimable(lockFile, mtimeMs + LOCK_STALE_MS - 1000), false, 'within window');
  });

  it('returns false for a missing lock file (nothing to steal)', async () => {
    const { isLockReclaimable } = await import('../hooks/capture-runner.js');
    rmSync(lockFile, { force: true });
    assert.equal(isLockReclaimable(lockFile), false);
  });
});

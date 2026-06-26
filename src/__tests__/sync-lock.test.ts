/**
 * Advisory sync lock (`.gipity/sync.lock`) - prevents concurrent sync
 * processes in the same project dir from corrupting the baseline manifest.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import the module under test with a throwaway HOME and cwd so it uses our
// temp project dir. Note: `acquireLock` reads the path via getConfigPath(),
// which walks up from cwd looking for .gipity.json.
let tempProject: string;
let originalCwd: string;

before(() => {
  originalCwd = process.cwd();
  tempProject = mkdtempSync(join(tmpdir(), 'gipity-lock-test-'));
  writeFileSync(join(tempProject, '.gipity.json'), JSON.stringify({
    projectGuid: 'proj_lock_test',
    projectSlug: 'lock-test',
    accountSlug: 'test',
    agentGuid: 'agt_test',
    conversationGuid: null,
    apiBase: 'https://test.invalid',
    ignore: [],
  }));
  mkdirSync(join(tempProject, '.gipity'), { recursive: true });
  process.chdir(tempProject);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tempProject, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean up any lock file between tests.
  try { rmSync(join(tempProject, '.gipity', 'sync.lock'), { force: true }); } catch { /* */ }
});

describe('acquireLock', () => {
  it('creates the lock file with the current PID', async () => {
    // Re-import so config cache is fresh with our tempProject cwd.
    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { acquireLock } = await import('../sync.js');

    const release = await acquireLock();
    const lockFile = join(tempProject, '.gipity', 'sync.lock');
    assert.ok(existsSync(lockFile), 'lock file should exist');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release();
    assert.ok(!existsSync(lockFile), 'lock file should be removed by release');
  });

  it('release is idempotent (safe to call twice, lockfile stays absent)', async () => {
    const lockFile = join(tempProject, '.gipity', 'sync.lock');
    const { acquireLock } = await import('../sync.js');
    const release = await acquireLock();
    assert.ok(existsSync(lockFile), 'precondition: lockfile exists after acquire');
    release();
    assert.ok(!existsSync(lockFile), 'lockfile gone after first release');
    release();  // Must not throw
    assert.ok(!existsSync(lockFile), 'lockfile stays absent after second release');
  });

  it('breaks a stale lock whose PID is dead', async () => {
    const lockFile = join(tempProject, '.gipity', 'sync.lock');
    // PID 1 exists but is init - but PID 999999 is almost certainly dead.
    // Find a definitely-dead PID by forking a process that exits instantly.
    const { execSync } = await import('child_process');
    const deadPid = parseInt(
      execSync('bash -c "(echo $$; exec sleep 0.01) & wait $!; echo $!"', { encoding: 'utf-8' })
        .split('\n').filter(Boolean).pop()!,
      10,
    );
    // Poll briefly to ensure the PID is free.
    let tries = 20;
    while (tries-- > 0) {
      try { process.kill(deadPid, 0); await new Promise(r => setTimeout(r, 10)); }
      catch { break; }
    }

    writeFileSync(lockFile, String(deadPid));
    const { acquireLock } = await import('../sync.js');
    const release = await acquireLock();  // should break the stale lock
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release();
  });

  it('waits for a live lock, then acquires when it releases', async () => {
    const { acquireLock } = await import('../sync.js');

    // First holder.
    const releaseA = await acquireLock();

    // Second caller must wait - start its promise, then release A, then await.
    let bResolved = false;
    const pB = acquireLock().then(r => { bResolved = true; return r; });

    // Give B a moment to start polling - it should NOT be resolved yet.
    await new Promise(r => setTimeout(r, 100));
    assert.equal(bResolved, false, 'second acquireLock should still be waiting');

    releaseA();

    // Poll cycle is 500ms; wait up to 1.5s for the wait loop to notice.
    const releaseB = await pB;
    assert.equal(bResolved, true);
    releaseB();
  });

  it('breaks an empty lock file (holder crashed before writing its PID)', async () => {
    const lockFile = join(tempProject, '.gipity', 'sync.lock');
    writeFileSync(lockFile, '');  // created, but PID never written
    const { acquireLock } = await import('../sync.js');
    const release = await acquireLock();  // must not deadlock - empty = abandoned
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release();
  });
});

describe('isLockReclaimable', () => {
  const lockFile = join(tempProject, '.gipity', 'sync.lock');

  it('reclaims an empty / garbage lock file', async () => {
    const { isLockReclaimable } = await import('../sync.js');
    writeFileSync(lockFile, '');
    assert.equal(isLockReclaimable(lockFile), true, 'empty lock');
    writeFileSync(lockFile, 'not-a-pid');
    assert.equal(isLockReclaimable(lockFile), true, 'garbage lock');
  });

  it('does NOT reclaim a live holder whose heartbeat is fresh', async () => {
    const { isLockReclaimable } = await import('../sync.js');
    writeFileSync(lockFile, String(process.pid));  // our own (alive) PID, just-written mtime
    assert.equal(isLockReclaimable(lockFile), false);
  });

  it('reclaims a live holder whose heartbeat went silent past the stale window', async () => {
    const { isLockReclaimable, LOCK_STALE_MS } = await import('../sync.js');
    writeFileSync(lockFile, String(process.pid));  // alive PID...
    const mtimeMs = statSync(lockFile).mtimeMs;
    // ...but evaluate as if "now" is well past the stale window (no heartbeat).
    assert.equal(isLockReclaimable(lockFile, mtimeMs + LOCK_STALE_MS + 1), true);
    assert.equal(isLockReclaimable(lockFile, mtimeMs + LOCK_STALE_MS - 1000), false);
  });

  it('returns false for a missing lock file (nothing to steal)', async () => {
    const { isLockReclaimable } = await import('../sync.js');
    rmSync(lockFile, { force: true });
    assert.equal(isLockReclaimable(lockFile), false);
  });
});

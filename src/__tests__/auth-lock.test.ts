/**
 * Cross-process auth-refresh lock (`~/.gipity/auth.lock`) - serializes token
 * refreshes across sibling `gipity` processes that share one auth.json, so they
 * don't race the SINGLE-USE refresh token and spuriously 401 ("session expired").
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// AUTH_DIR is captured from GIPITY_DIR at module load, so set it BEFORE importing
// auth.js. The lock lives at <GIPITY_DIR>/auth.lock.
let authDir: string;
let lockFile: string;

before(() => {
  authDir = mkdtempSync(join(tmpdir(), 'gipity-auth-lock-test-'));
  process.env.GIPITY_DIR = authDir;
  lockFile = join(authDir, 'auth.lock');
});

after(() => {
  delete process.env.GIPITY_DIR;
  rmSync(authDir, { recursive: true, force: true });
});

beforeEach(() => {
  try { rmSync(lockFile, { force: true }); } catch { /* */ }
});

describe('acquireRefreshLock', () => {
  it('creates the lock file with the current PID and removes it on release', async () => {
    const { acquireRefreshLock } = await import('../auth.js');
    const release = await acquireRefreshLock();
    assert.ok(release, 'should acquire the lock');
    assert.ok(existsSync(lockFile), 'lock file should exist while held');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release!();
    assert.ok(!existsSync(lockFile), 'lock file should be gone after release');
  });

  it('release is idempotent (safe to call twice)', async () => {
    const { acquireRefreshLock } = await import('../auth.js');
    const release = await acquireRefreshLock();
    release!();
    assert.ok(!existsSync(lockFile), 'lockfile gone after first release');
    release!();  // must not throw
    assert.ok(!existsSync(lockFile), 'lockfile stays absent after second release');
  });

  it('breaks a stale lock whose PID is dead', async () => {
    // Spawn a process that exits immediately to harvest a definitely-dead PID.
    const { execSync } = await import('child_process');
    const deadPid = parseInt(
      execSync('bash -c "(echo $$; exec sleep 0.01) & wait $!; echo $!"', { encoding: 'utf-8' })
        .split('\n').filter(Boolean).pop()!,
      10,
    );
    let tries = 20;
    while (tries-- > 0) {
      try { process.kill(deadPid, 0); await new Promise(r => setTimeout(r, 10)); }
      catch { break; }
    }

    writeFileSync(lockFile, String(deadPid));
    const { acquireRefreshLock } = await import('../auth.js');
    const release = await acquireRefreshLock();   // should reclaim the stale lock
    assert.ok(release, 'should reclaim and acquire');
    assert.equal(parseInt(readFileSync(lockFile, 'utf-8'), 10), process.pid);
    release!();
  });

  it('waits for a live lock, then acquires when it releases', async () => {
    const { acquireRefreshLock } = await import('../auth.js');

    const releaseA = await acquireRefreshLock();
    assert.ok(releaseA, 'first holder should acquire');

    let bResolved = false;
    const pB = acquireRefreshLock().then(r => { bResolved = true; return r; });

    await new Promise(r => setTimeout(r, 250));   // poll is 100ms; B must still be waiting
    assert.equal(bResolved, false, 'second acquire should still be waiting');

    releaseA!();

    const releaseB = await pB;
    assert.equal(bResolved, true);
    assert.ok(releaseB, 'second caller should acquire after release');
    releaseB!();
  });
});

// JWT with a custom `exp` (seconds from now) so decodeJwtExp resolves it.
function jwtExpiringIn(seconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

// Guards the up-front login-state messaging in `gipity claude`: sessionExpired()
// (refresh-token lifetime) and accessTokenExpired() (access-token usability now)
// must disagree exactly in the case that produced the "Logged in" → "session
// expired" contradiction — a still-valid refresh token whose rotation/renewal
// failed, leaving the access token expired.
describe('sessionExpired vs accessTokenExpired', () => {
  it('both false when refresh and access tokens are valid', async () => {
    const { saveAuth, sessionExpired, accessTokenExpired } = await import('../auth.js');
    saveAuth({
      accessToken: jwtExpiringIn(900),
      refreshToken: jwtExpiringIn(7 * 24 * 3600),
      email: 'ec-test@914-6.com',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    assert.equal(sessionExpired(), false);
    assert.equal(accessTokenExpired(), false);
  });

  it('refresh token live but access token already expired → session looks valid, access does not', async () => {
    const { saveAuth, sessionExpired, accessTokenExpired } = await import('../auth.js');
    saveAuth({
      accessToken: jwtExpiringIn(-60),
      refreshToken: jwtExpiringIn(7 * 24 * 3600), // not time-expired (e.g. rotated away by a sibling)
      email: 'ec-test@914-6.com',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(sessionExpired(), false, 'refresh token has not lapsed');
    assert.equal(accessTokenExpired(), true, 'access token is past expiry → re-login required');
  });

  it('both true when there is no saved auth', async () => {
    const { clearAuth, sessionExpired, accessTokenExpired } = await import('../auth.js');
    clearAuth();
    assert.equal(sessionExpired(), true);
    assert.equal(accessTokenExpired(), true);
  });
});

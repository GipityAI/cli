/**
 * `~/.gipity/relay.json` state module - device info, allowlist, pause flag.
 * Uses HOME to sandbox filesystem writes.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';

/** Each test gets a fresh HOME and re-imports state with a cache-busting query. */
async function fresh(): Promise<{ state: typeof import('../relay/state.js'); home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gipity-relay-state-'));
  process.env.HOME = home;
  // RELAY_DIR honors GIPITY_DIR (see state.ts); clear it so these tests assert the
  // default ~/.gipity path under the sandboxed HOME regardless of the ambient env.
  delete process.env.GIPITY_DIR;
  // `os.homedir()` reads $HOME on POSIX lazily, so a bare require/import gives
  // the fresh value. Import dynamically so the module's top-level constants
  // are re-evaluated against our temp HOME.
  const state = await import(`../relay/state.js?t=${Date.now()}${Math.random()}`);
  return { state, home };
}

describe('relay state: device round-trip', () => {
  it('loadState returns empty defaults when no file exists', async () => {
    const { state } = await fresh();
    const s = state.loadState();
    assert.equal(s.device, null);
    assert.equal(s.paused, false);
  });

  it('setDevice / getDevice / clearDevice round-trips and writes chmod 0600', async () => {
    const { state, home } = await fresh();
    state.setDevice({
      guid: 'rd_abc12345',
      name: 'Work Mac',
      platform: 'darwin',
      token: 'super-secret-token',
      paired_at: '2026-04-14T00:00:00Z',
    });
    const d = state.getDevice();
    assert.equal(d?.guid, 'rd_abc12345');
    assert.equal(d?.token, 'super-secret-token');

    const path = join(home, '.gipity', 'relay.json');
    assert.ok(existsSync(path));
    const mode = statSync(path).mode & 0o777;
    // POSIX: enforced 0600. Windows: chmod is a no-op; skip the assertion there.
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }

    state.clearDevice();
    assert.equal(state.getDevice(), null);
  });

  it('clearDevice also clears pause flag', async () => {
    const { state } = await fresh();
    state.setDevice({
      guid: 'rd_x', name: 'x', platform: 'linux', token: 't', paired_at: '2026-04-14',
    });
    state.setPaused(true);

    state.clearDevice();

    assert.equal(state.getDevice(), null);
    assert.equal(state.isPaused(), false);
  });
});

describe('relay state: pause flag', () => {
  it('setPaused / isPaused round-trip', async () => {
    const { state } = await fresh();
    assert.equal(state.isPaused(), false);
    state.setPaused(true);
    assert.equal(state.isPaused(), true);
    state.setPaused(false);
    assert.equal(state.isPaused(), false);
  });
});

describe('relay state: corrupted file recovery', () => {
  it('treats malformed JSON as empty state, does not throw', async () => {
    const { state, home } = await fresh();
    const dir = join(home, '.gipity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'relay.json'), '{ not json');

    const s = state.loadState();
    assert.equal(s.device, null);
    assert.equal(s.paused, false);

    // And we can still save cleanly on top of it.
    state.setPaused(true);
    assert.equal(state.loadState().paused, true);
  });
});

describe('relay daemon pid lock: stale-file recovery', () => {
  // Regression: a leftover pid file from an unclean exit used to trap the daemon
  // in a permanent restart loop ("another daemon is already running") because
  // boot bailed on EEXIST without checking the recorded PID was actually alive.
  // isDaemonRunning() must clear a stale file so the next start can take the lock.

  it('clears a stale pid file (dead process) and reports not-running', async () => {
    const { state, home } = await fresh();
    const dir = join(home, '.gipity');
    mkdirSync(dir, { recursive: true });

    // A real, now-dead pid: spawn a child, kill it, wait for it to exit.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const deadPid = child.pid!;
    await new Promise<void>(res => { child.once('exit', () => res()); child.kill('SIGKILL'); });

    state.writeDaemonPid(deadPid);
    const pidPath = join(dir, 'relay.pid');
    assert.ok(existsSync(pidPath), 'precondition: pid file written');

    assert.equal(state.isDaemonRunning(), false, 'dead pid → not running');
    assert.equal(existsSync(pidPath), false, 'stale pid file should be cleared');
  });

  it('clears a corrupt pid file and reports not-running', async () => {
    const { state, home } = await fresh();
    const dir = join(home, '.gipity');
    mkdirSync(dir, { recursive: true });
    const pidPath = join(dir, 'relay.pid');
    writeFileSync(pidPath, 'not-a-pid');

    assert.equal(state.isDaemonRunning(), false);
    assert.equal(existsSync(pidPath), false, 'corrupt pid file should be cleared');
  });

  it('keeps the pid file and reports running for a DIFFERENT live process', async () => {
    const { state, home } = await fresh();
    const dir = join(home, '.gipity');
    mkdirSync(dir, { recursive: true });
    // A genuinely-other live process (not us): a long-lived child.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const livePid = child.pid!;
    try {
      const pidPath = join(dir, 'relay.pid');
      writeFileSync(pidPath, String(livePid));
      assert.equal(state.isDaemonRunning(), true, 'a different live pid → running');
      assert.ok(existsSync(pidPath), 'live pid file must NOT be cleared');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('treats OUR OWN pid in the file as stale (the container restart case)', async () => {
    // In a container the daemon is always pid 1, so a --restart brings us back as
    // pid 1 with the dead run's relay.pid (also 1). isDaemonRunning() must NOT read
    // that as "a live peer" (it's us) - it would trap the daemon in a restart loop.
    const { state, home } = await fresh();
    const dir = join(home, '.gipity');
    mkdirSync(dir, { recursive: true });
    const pidPath = join(dir, 'relay.pid');
    writeFileSync(pidPath, String(process.pid)); // our own pid = a leftover, not a peer

    assert.equal(state.isDaemonRunning(), false, 'own pid → stale, not running');
    assert.equal(existsSync(pidPath), false, 'own-pid file should be cleared so restart can proceed');
  });
});

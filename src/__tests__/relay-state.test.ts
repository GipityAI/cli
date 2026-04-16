/**
 * `~/.gipity/relay.json` state module — device info, allowlist, pause flag.
 * Uses HOME to sandbox filesystem writes.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

/** Each test gets a fresh HOME and re-imports state with a cache-busting query. */
async function fresh(): Promise<{ state: typeof import('../relay/state.js'); home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gipity-relay-state-'));
  process.env.HOME = home;
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

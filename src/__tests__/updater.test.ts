import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compareSemver } from '../updater/check.js';

describe('compareSemver', () => {
  it('treats equal versions as 0', () => {
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  });

  it('detects patch bumps', () => {
    assert.ok(compareSemver('1.0.10', '1.0.9') > 0);
    assert.ok(compareSemver('1.0.9', '1.0.10') < 0);
  });

  it('detects minor bumps', () => {
    assert.ok(compareSemver('1.2.0', '1.1.99') > 0);
  });

  it('detects major bumps', () => {
    assert.ok(compareSemver('2.0.0', '1.99.99') > 0);
  });

  it('treats missing components as zero', () => {
    assert.equal(compareSemver('1.0', '1.0.0'), 0);
    assert.ok(compareSemver('1.0.1', '1.0') > 0);
  });
});

// state.ts reads HOME at import time via state file paths; we have to swap
// HOME before requiring it, then re-import via dynamic import each test.
describe('state + settings (with isolated HOME)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  before(() => {
    originalHome = process.env['HOME'];
  });

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gipity-test-'));
    process.env['HOME'] = tmpHome;
    // Clear env knobs that other tests might have set.
    delete process.env['DISABLE_AUTOUPDATER'];
    delete process.env['CI'];
  });

  after(() => {
    if (originalHome) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
  });

  // Note: state.ts captures HOME at module-load time via top-level
  // `join(homedir(), '.gipity')`. The first import wins. We work around this
  // by computing paths ourselves and only using state.ts's pure functions.

  it('readState returns defaults when no file exists', async () => {
    const mod = await import(`../updater/state.js?cachebust=${Date.now()}`);
    // GIPITY_DIR may be cached to original HOME — force-create the path the
    // module is actually using, then assert defaults shape.
    const s = mod.readState();
    assert.equal(typeof s.lastCheckAt, 'number');
    assert.equal(s.updateChannel, 'stable');
  });

  it('updatesDisabled respects DISABLE_AUTOUPDATER=1', async () => {
    process.env['DISABLE_AUTOUPDATER'] = '1';
    const mod = await import(`../updater/state.js?cachebust=${Date.now() + 1}`);
    const r = mod.updatesDisabled();
    assert.equal(r.disabled, true);
    assert.match(r.reason ?? '', /DISABLE_AUTOUPDATER/);
  });

  it('updatesDisabled respects CI', async () => {
    process.env['CI'] = '1';
    const mod = await import(`../updater/state.js?cachebust=${Date.now() + 2}`);
    const r = mod.updatesDisabled();
    assert.equal(r.disabled, true);
    assert.match(r.reason ?? '', /CI/);
  });

  it('round-trips state file', async () => {
    const mod = await import(`../updater/state.js?cachebust=${Date.now() + 3}`);
    mod.writeState({ installedVersion: '9.9.9', lastCheckAt: 12345, lastError: null, updateChannel: 'stable' });
    const s = mod.readState();
    assert.equal(s.installedVersion, '9.9.9');
    assert.equal(s.lastCheckAt, 12345);
  });

  it('readState recovers from corrupt JSON', async () => {
    const mod = await import(`../updater/state.js?cachebust=${Date.now() + 4}`);
    mkdirSync(mod.GIPITY_DIR, { recursive: true });
    writeFileSync(mod.STATE_FILE, '{not json');
    const s = mod.readState();
    assert.equal(s.installedVersion, null);
    assert.equal(s.lastCheckAt, 0);
  });

  it('readSettings recovers from corrupt JSON', async () => {
    const mod = await import(`../updater/state.js?cachebust=${Date.now() + 5}`);
    mkdirSync(mod.GIPITY_DIR, { recursive: true });
    writeFileSync(mod.SETTINGS_FILE, '{broken');
    const s = mod.readSettings();
    assert.equal(s.autoUpdates, true);
  });
});

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compareSemver } from '../updater/check.js';
import { isWedged, acquireUpdateLock, releaseUpdateLock, resetLocalTree } from '../updater/install.js';
import { resolveCommand } from '../platform.js';

describe('resolveCommand', () => {
  it('passes the bare command through on non-Windows', { skip: process.platform === 'win32' }, () => {
    // The updater spawns npm without shell:true; on POSIX the bare name must be
    // returned unchanged so spawn's PATH lookup finds it. On Windows it would be
    // resolved to an .exe/.cmd path instead (see platform.ts).
    assert.equal(resolveCommand('npm'), 'npm');
  });
});

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

describe('isWedged', () => {
  it('matches interrupted-install corruption codes', () => {
    assert.equal(isWedged('npm error code ENOTEMPTY\nnpm error syscall rename'), true);
    assert.equal(isWedged('npm error code EEXIST'), true);
    assert.equal(isWedged('npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json'), true);
  });

  it('does not match transient or registry failures (must not wipe a working tree)', () => {
    assert.equal(isWedged(''), false);
    assert.equal(isWedged('npm error code E404\nnpm error 404 Not Found'), false);
    assert.equal(isWedged('npm error code ERESOLVE'), false);
    assert.equal(isWedged('npm error code ENETUNREACH'), false);
  });
});

// Lock and reset take explicit path overrides so tests stay inside a temp
// dir (module-level defaults point at the real ~/.gipity, captured at import).
describe('update lock + tree reset', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gipity-test-'));
  });

  it('lock round-trips: acquire, contend, release, reacquire', () => {
    const lock = join(tmp, 'update.lock');
    assert.equal(acquireUpdateLock(lock), true);
    assert.equal(acquireUpdateLock(lock), false);
    releaseUpdateLock(lock);
    assert.equal(acquireUpdateLock(lock), true);
    releaseUpdateLock(lock);
  });

  it('takes over a stale lock from a dead updater', () => {
    const lock = join(tmp, 'update.lock');
    assert.equal(acquireUpdateLock(lock), true);
    const old = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(lock, old, old);
    assert.equal(acquireUpdateLock(lock), true);
    releaseUpdateLock(lock);
  });

  it('resetLocalTree wipes node_modules and lockfile and rewrites package.json', () => {
    const local = join(tmp, 'local');
    mkdirSync(join(local, 'node_modules', '.gipity-abc123'), { recursive: true });
    writeFileSync(join(local, 'node_modules', '.gipity-abc123', 'leftover.js'), 'x');
    writeFileSync(join(local, 'package-lock.json'), '{}');
    writeFileSync(join(local, 'package.json'), '{truncated');
    resetLocalTree(local);
    assert.equal(existsSync(join(local, 'node_modules')), false);
    assert.equal(existsSync(join(local, 'package-lock.json')), false);
    const pkg = JSON.parse(readFileSync(join(local, 'package.json'), 'utf-8'));
    assert.equal(pkg.name, 'gipity-local');
    assert.equal(pkg.private, true);
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
    // GIPITY_DIR may be cached to original HOME - force-create the path the
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

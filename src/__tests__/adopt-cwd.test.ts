/**
 * Unit tests for the cwd-adoption helpers. Pure logic + small fs walks
 * inside tmp dirs - no network, no real platform state.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, sep } from 'path';
import {
  scanForAdoption,
  isLikelyEmpty,
  canAdoptCwd,
  formatCwdLabel,
  formatBytes,
} from '../adopt-cwd.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gipity-adopt-test-'));
});

after(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

function mkdir(p: string): string {
  const full = join(root, p);
  mkdirSync(full, { recursive: true });
  return full;
}

function writeBytes(dir: string, name: string, n: number): void {
  writeFileSync(join(dir, name), Buffer.alloc(n));
}

describe('scanForAdoption', () => {
  it('returns easy tier for a tiny project', () => {
    const d = mkdir('easy');
    writeBytes(d, 'a.txt', 10);
    writeBytes(d, 'b.txt', 10);
    const s = scanForAdoption(d);
    assert.equal(s.tier, 'easy');
    assert.equal(s.files, 2);
    assert.equal(s.bytes, 20);
    assert.equal(s.truncated, false);
  });

  it('handles a missing directory gracefully', () => {
    const s = scanForAdoption(join(root, 'no-such-dir'));
    assert.equal(s.tier, 'easy');
    assert.equal(s.files, 0);
  });

  it('walks nested directories', () => {
    const d = mkdir('nested');
    const sub = mkdir('nested/sub/sub2');
    writeBytes(d, 'top.txt', 1);
    writeBytes(sub, 'deep.txt', 2);
    const s = scanForAdoption(d);
    assert.equal(s.files, 2);
    assert.equal(s.bytes, 3);
  });

  it('returns moderate tier when over the easy file-count threshold', () => {
    const d = mkdir('moderate-files');
    for (let i = 0; i < 250; i++) writeBytes(d, `f${i}.txt`, 1);
    const s = scanForAdoption(d);
    assert.equal(s.tier, 'moderate');
    assert.equal(s.truncated, false);
  });

  it('returns refuse + truncated when over the refuse file-count threshold', () => {
    const d = mkdir('refuse-files');
    for (let i = 0; i < 2100; i++) writeBytes(d, `f${i}.txt`, 1);
    const s = scanForAdoption(d);
    assert.equal(s.tier, 'refuse');
    assert.equal(s.truncated, true);
  });

  it('skips sync-ignored entries (node_modules, .git)', () => {
    const d = mkdir('with-junk');
    writeBytes(d, 'real.txt', 1);
    const nm = mkdir('with-junk/node_modules');
    writeBytes(nm, 'should-not-count.txt', 999_999);
    const git = mkdir('with-junk/.git');
    writeBytes(git, 'also-skip.txt', 999_999);
    const s = scanForAdoption(d);
    assert.equal(s.files, 1);
    assert.equal(s.bytes, 1);
  });
});

describe('isLikelyEmpty', () => {
  it('true for a truly empty dir', () => {
    const d = mkdir('empty');
    assert.equal(isLikelyEmpty(d), true);
  });

  it('true for a dir with only sync-ignored entries', () => {
    const d = mkdir('only-junk');
    mkdir('only-junk/node_modules');
    mkdir('only-junk/.git');
    assert.equal(isLikelyEmpty(d), true);
  });

  it('false when there is any real file', () => {
    const d = mkdir('not-empty');
    writeBytes(d, 'hello.md', 1);
    assert.equal(isLikelyEmpty(d), false);
  });

  it('true when the dir does not exist', () => {
    assert.equal(isLikelyEmpty(join(root, 'ghost')), true);
  });
});

describe('canAdoptCwd', () => {
  it('refuses the filesystem root', () => {
    assert.equal(canAdoptCwd(sep), false);
  });

  it('refuses the user\'s home directory', () => {
    assert.equal(canAdoptCwd(homedir()), false);
  });

  it('refuses system dirs', () => {
    assert.equal(canAdoptCwd('/tmp'), false);
    assert.equal(canAdoptCwd('/etc'), false);
    assert.equal(canAdoptCwd('/usr'), false);
  });

  it('allows a subdirectory of /tmp', () => {
    const d = mkdir('allowed-subdir');
    assert.equal(canAdoptCwd(d), true);
  });

  it('refuses a workspace-parent (depth ≤1 below home with 3+ git children)', () => {
    // Simulate ~/Workspace/{a,b,c}/.git
    const ws = mkdtempSync(join(homedir(), 'gipity-adopt-ws-'));
    try {
      for (const sub of ['a', 'b', 'c']) {
        mkdirSync(join(ws, sub, '.git'), { recursive: true });
      }
      assert.equal(canAdoptCwd(ws), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('allows a single-project dir even at depth ≤1 under home', () => {
    const single = mkdtempSync(join(homedir(), 'gipity-adopt-single-'));
    try {
      mkdirSync(join(single, '.git'), { recursive: true });
      assert.equal(canAdoptCwd(single), true);
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });
});

describe('formatCwdLabel', () => {
  it('returns "~" for the home dir', () => {
    assert.equal(formatCwdLabel(homedir()), '~');
  });

  it('uses ~/tail when 1-2 segments deep in home', () => {
    assert.equal(formatCwdLabel(join(homedir(), 'Github')), '~/Github');
    assert.equal(formatCwdLabel(join(homedir(), 'Github', 'Gipity')), '~/Github/Gipity');
  });

  it('uses ~/.../last-2 when deeper in home', () => {
    const deep = join(homedir(), 'a', 'b', 'c', 'd');
    assert.equal(formatCwdLabel(deep), '~/.../c/d');
  });

  it('shows parent/this for non-home paths', () => {
    assert.equal(formatCwdLabel('/tmp/scratch'), 'tmp/scratch');
  });
});

describe('formatBytes', () => {
  it('B for sub-KB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
  });

  it('KB for sub-MB', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(2048), '2.0 KB');
  });

  it('MB for sub-GB', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MB');
  });

  it('GB for ≥ GB (fixes the "1024.0 MB" overflow at the refuse threshold)', () => {
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
    assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');
  });

  it('TB for ≥ TB (the top plan\'s storage quota is a flat 1 TB)', () => {
    assert.equal(formatBytes(1024 ** 4), '1.00 TB');
    assert.equal(formatBytes(2.5 * 1024 ** 4), '2.50 TB');
  });
});

/**
 * markFolderTrusted - pre-accepts Claude Code's per-directory workspace-trust
 * dialog by writing `projects["<dir>"].hasTrustDialogAccepted` into
 * ~/.claude.json. Verifies the write is additive (every other key preserved),
 * idempotent, and never clobbers a malformed config.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { markFolderTrusted } from '../commands/build.js';

const PROJECT = '/home/test/GipityProjects/project-001';
let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/gipity-trust-test-`);
  origHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() honors $HOME on POSIX
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

function claudeJson(): string { return join(home, '.claude.json'); }
function readCfg(): any { return JSON.parse(readFileSync(claudeJson(), 'utf-8')); }

describe('markFolderTrusted', () => {
  it('adds the trust entry while preserving other top-level keys and projects', () => {
    writeFileSync(claudeJson(), JSON.stringify({
      numStartups: 42,
      projects: { '/some/other/dir': { hasTrustDialogAccepted: true, foo: 1 } },
    }));
    markFolderTrusted(PROJECT);
    const cfg = readCfg();
    assert.equal(cfg.projects[PROJECT].hasTrustDialogAccepted, true);
    assert.equal(cfg.numStartups, 42, 'unrelated top-level keys preserved');
    assert.deepEqual(cfg.projects['/some/other/dir'], { hasTrustDialogAccepted: true, foo: 1 },
      'other projects untouched');
  });

  it('merges into an existing project entry without dropping its other fields', () => {
    writeFileSync(claudeJson(), JSON.stringify({
      projects: { [PROJECT]: { allowedTools: ['Bash'], history: [1, 2] } },
    }));
    markFolderTrusted(PROJECT);
    const cfg = readCfg();
    assert.equal(cfg.projects[PROJECT].hasTrustDialogAccepted, true);
    assert.deepEqual(cfg.projects[PROJECT].allowedTools, ['Bash']);
    assert.deepEqual(cfg.projects[PROJECT].history, [1, 2]);
  });

  it('is a no-op when the folder is already trusted', () => {
    const original = JSON.stringify({
      projects: { [PROJECT]: { hasTrustDialogAccepted: true } },
    }, null, 2);
    writeFileSync(claudeJson(), original);
    markFolderTrusted(PROJECT);
    assert.equal(readFileSync(claudeJson(), 'utf-8'), original, 'file untouched');
  });

  it('creates ~/.claude.json when it does not exist', () => {
    assert.equal(existsSync(claudeJson()), false);
    markFolderTrusted(PROJECT);
    assert.equal(readCfg().projects[PROJECT].hasTrustDialogAccepted, true);
  });

  it('leaves a malformed config untouched and does not throw', () => {
    const garbage = '{ this is not json';
    writeFileSync(claudeJson(), garbage);
    assert.doesNotThrow(() => markFolderTrusted(PROJECT));
    assert.equal(readFileSync(claudeJson(), 'utf-8'), garbage, 'malformed file not clobbered');
  });
});

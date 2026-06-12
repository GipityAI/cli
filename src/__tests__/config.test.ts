import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  shouldIgnore,
  saveConfig,
  saveConfigAt,
  clearConfigCache,
  isAllowedApiHost,
  resolveApiBase,
  setApiBaseOverride,
  DEFAULT_API_BASE,
  type GipityConfig,
} from '../config.js';

describe('shouldIgnore', () => {
  const patterns = ['node_modules', '.git', '.gipity.json', '.gipity/', '.claude/', '*.log'];

  it('ignores exact match', () => {
    assert.equal(shouldIgnore('.gipity.json', patterns), true);
  });

  it('ignores directory name anywhere in path', () => {
    assert.equal(shouldIgnore('node_modules', patterns), true);
    assert.equal(shouldIgnore('src/node_modules/foo.js', patterns), true);
    assert.equal(shouldIgnore('.git', patterns), true);
  });

  it('ignores prefix match with trailing slash', () => {
    assert.equal(shouldIgnore('.gipity/sync-state.json', patterns), true);
    assert.equal(shouldIgnore('.claude/settings.json', patterns), true);
  });

  it('ignores extension match', () => {
    assert.equal(shouldIgnore('app.log', patterns), true);
    assert.equal(shouldIgnore('logs/error.log', patterns), true);
  });

  it('does not ignore non-matching paths', () => {
    assert.equal(shouldIgnore('src/index.ts', patterns), false);
    assert.equal(shouldIgnore('package.json', patterns), false);
    assert.equal(shouldIgnore('README.md', patterns), false);
  });

  it('handles empty patterns', () => {
    assert.equal(shouldIgnore('anything.ts', []), false);
  });

  // Previously-unsupported gitignore forms — these silently did NOT match before,
  // so files users believed were excluded synced and deployed anyway.
  it('supports a path glob like data/*.csv', () => {
    const p = ['data/*.csv'];
    assert.equal(shouldIgnore('data/report.csv', p), true);
    assert.equal(shouldIgnore('data/nested/report.csv', p), false); // single level only
    assert.equal(shouldIgnore('other/report.csv', p), false);
  });

  it('supports a root-anchored pattern like /build', () => {
    const p = ['/build'];
    assert.equal(shouldIgnore('build', p), true);
    assert.equal(shouldIgnore('build/app.js', p), true);
    assert.equal(shouldIgnore('src/build/app.js', p), false); // anchored to root
  });

  it('supports a double-star pattern like **/scratch', () => {
    const p = ['**/scratch'];
    assert.equal(shouldIgnore('scratch', p), true);
    assert.equal(shouldIgnore('a/b/scratch', p), true);
  });

  it('supports negation (a later ! pattern re-includes)', () => {
    const p = ['*.log', '!keep.log'];
    assert.equal(shouldIgnore('app.log', p), true);
    assert.equal(shouldIgnore('keep.log', p), false);
  });
});

const SAMPLE: GipityConfig = {
  projectGuid: 'p_Test00000',
  projectSlug: 'test-proj',
  accountSlug: 'test-acct',
  agentGuid: 'a_Test00000',
  conversationGuid: null,
  apiBase: 'https://a.gipity.ai',
  ignore: [],
};

describe('isAllowedApiHost (token-redirect guard)', () => {
  it('accepts the canonical Gipity hosts over https', () => {
    assert.equal(isAllowedApiHost('https://a.gipity.ai'), true);
    assert.equal(isAllowedApiHost('https://gipity.ai'), true);
    assert.equal(isAllowedApiHost('https://dev.gipity.ai/x'), true);
  });

  it('rejects non-Gipity hosts, http, and lookalikes', () => {
    assert.equal(isAllowedApiHost('https://evil.example'), false);
    assert.equal(isAllowedApiHost('http://a.gipity.ai'), false);          // not https
    assert.equal(isAllowedApiHost('https://gipity.ai.evil.com'), false);  // suffix trick
    assert.equal(isAllowedApiHost('https://notgipity.ai'), false);        // not a subdomain
    assert.equal(isAllowedApiHost('not a url'), false);
  });
});

describe('resolveApiBase (untrusted .gipity.json apiBase is ignored)', () => {
  it('falls back to the default when a poisoned config points off-allowlist', () => {
    const cwd0 = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'gip-apibase-'));
    try {
      setApiBaseOverride('');  // no explicit --api-base flag
      writeFileSync(join(dir, '.gipity.json'), JSON.stringify({ ...SAMPLE, apiBase: 'https://evil.example' }));
      process.chdir(dir);
      clearConfigCache();
      assert.equal(resolveApiBase(), DEFAULT_API_BASE);
    } finally {
      process.chdir(cwd0);
      clearConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors an allowed Gipity host from config', () => {
    const cwd0 = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'gip-apibase-'));
    try {
      setApiBaseOverride('');
      writeFileSync(join(dir, '.gipity.json'), JSON.stringify({ ...SAMPLE, apiBase: 'https://dev.gipity.ai' }));
      process.chdir(dir);
      clearConfigCache();
      assert.equal(resolveApiBase(), 'https://dev.gipity.ai');
    } finally {
      process.chdir(cwd0);
      clearConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('saveConfig / saveConfigAt', () => {
  it('saveConfigAt writes .gipity.json at the given directory', () => {
    const cwd0 = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'gipity-cfg-'));
    try {
      saveConfigAt(dir, SAMPLE);
      assert.ok(existsSync(join(dir, '.gipity.json')));
      const parsed = JSON.parse(readFileSync(join(dir, '.gipity.json'), 'utf-8'));
      assert.equal(parsed.projectSlug, 'test-proj');
    } finally {
      process.chdir(cwd0);
      clearConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveConfig throws - and creates nothing - when there is no config to update', () => {
    const cwd0 = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'gipity-cfg-'));
    try {
      process.chdir(dir);
      clearConfigCache();
      assert.throws(() => saveConfig(SAMPLE), /no \.gipity\.json/);
      assert.equal(
        existsSync(join(dir, '.gipity.json')), false,
        'saveConfig must never create a new config file',
      );
    } finally {
      process.chdir(cwd0);
      clearConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveConfig updates the ancestor config found via walk-up, not the subdir', () => {
    const cwd0 = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'gipity-cfg-'));
    try {
      saveConfigAt(dir, SAMPLE);
      const sub = join(dir, 'a', 'b');
      mkdirSync(sub, { recursive: true });
      process.chdir(sub);
      clearConfigCache();

      saveConfig({ ...SAMPLE, conversationGuid: 'c_Updated000' });

      assert.equal(
        existsSync(join(sub, '.gipity.json')), false,
        'saveConfig must not drop a config into the subdirectory',
      );
      const parsed = JSON.parse(readFileSync(join(dir, '.gipity.json'), 'utf-8'));
      assert.equal(parsed.conversationGuid, 'c_Updated000');
    } finally {
      process.chdir(cwd0);
      clearConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

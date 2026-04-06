import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIgnore } from '../config.js';

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
});

/**
 * Pure checks for the Claude Code install plan. Like relay-installers, we test
 * the platform-appropriate command generation, NOT the actual `which`/`npm`
 * execution (host-mutating; verified by hand).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeInstallPlan, CLAUDE_PACKAGE } from '../claude-setup.js';

describe('claudeInstallPlan', () => {
  it('uses `where claude` on Windows', () => {
    assert.equal(claudeInstallPlan('win32').checkCmd, 'where claude');
  });

  it('uses `which claude` on macOS and Linux', () => {
    assert.equal(claudeInstallPlan('darwin').checkCmd, 'which claude');
    assert.equal(claudeInstallPlan('linux').checkCmd, 'which claude');
  });

  it('installs the Claude Code package globally via npm', () => {
    const { installArgv } = claudeInstallPlan('linux');
    assert.equal(installArgv[0], 'npm');
    assert.ok(installArgv.includes('-g'));
    assert.ok(installArgv.includes(CLAUDE_PACKAGE));
    assert.equal(CLAUDE_PACKAGE, '@anthropic-ai/claude-code');
  });
});

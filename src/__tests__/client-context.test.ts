/**
 * Harness detection for the `X-Gipity-Client` header. The CLI infers what's
 * running it (a human vs. Claude Code / Codex / CI) from environment variables
 * the harness leaks into our process. These assert the detection precedence and
 * that Claude Code's version/session are parsed out.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectHarness } from '../client-context.js';

// Snapshot the env keys our detection reads so each case starts clean.
const TOUCHED = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CODEX_SANDBOX', 'CURSOR_TRACE_ID', 'TERM_PROGRAM', 'AIDER_MODEL', 'GEMINI_CLI',
  'CI', 'GITHUB_ACTIONS',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('manual when no harness env present', () => {
  assert.equal(detectHarness().harness, 'manual');
});

test('claude-code via CLAUDECODE=1, with version + session parsed', () => {
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_EXECPATH = '/home/u/.local/share/claude/versions/2.1.186';
  process.env.CLAUDE_CODE_SESSION_ID = 'abc-123';
  const h = detectHarness();
  assert.equal(h.harness, 'claude-code');
  assert.equal(h.harnessVersion, '2.1.186');
  assert.equal(h.harnessSession, 'abc-123');
});

test('claude-code via CLAUDE_CODE_ENTRYPOINT even without CLAUDECODE', () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  assert.equal(detectHarness().harness, 'claude-code');
});

test('codex via CODEX_ prefix', () => {
  process.env.CODEX_SANDBOX = 'seatbelt';
  assert.equal(detectHarness().harness, 'codex');
});

test('cursor via TERM_PROGRAM', () => {
  process.env.TERM_PROGRAM = 'cursor';
  assert.equal(detectHarness().harness, 'cursor');
});

test('ci when only CI env is set (no harness)', () => {
  process.env.CI = 'true';
  assert.equal(detectHarness().harness, 'ci');
});

test('a real harness wins over CI', () => {
  process.env.CI = 'true';
  process.env.CLAUDECODE = '1';
  assert.equal(detectHarness().harness, 'claude-code');
});

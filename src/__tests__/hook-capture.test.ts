/**
 * `gipity hook-capture <event>` — hidden subcommand wired into Claude Code
 * hooks. Runs in every Claude Code turn (even in directories that aren't
 * Gipity projects) and MUST never disrupt the session: silent no-op when
 * there's no .gipity.json or no auth, exit 0 on bad input.
 *
 * We can't exercise the happy path here (needs a live backend). These
 * smoke tests cover the "must never break Claude Code" contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { CLI_ENTRY } from './helpers/spawn-cli.js';

function runWithStdin(args: string[], stdin: string, cwd?: string) {
  const home = mkdtempSync(`${tmpdir()}/gipity-hc-test-`);
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf-8',
    cwd: cwd ?? home,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      NO_COLOR: '1',
      CI: '1',
      DISABLE_AUTOUPDATER: '1',
    },
    input: stdin,
    timeout: 10_000,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
}

describe('gipity hook-capture: silent-no-op contract', () => {
  const validPayload = JSON.stringify({
    session_id: 'sid_test_12345',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'a\nb', exit_code: 0 },
  });

  it('exits 0 silently when no .gipity.json and no auth (hottest path)', () => {
    const r = runWithStdin(['hook-capture', 'tool'], validPayload);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', `expected no stdout, got: ${r.stdout}`);
    assert.equal(r.stderr, '', `expected no stderr, got: ${r.stderr}`);
  });

  it('exits 0 silently on malformed JSON stdin', () => {
    const r = runWithStdin(['hook-capture', 'prompt'], 'not json {{{{');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  it('exits 0 silently on an unknown event name', () => {
    const r = runWithStdin(['hook-capture', 'totally-made-up'], validPayload);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  it('exits 0 silently on empty stdin', () => {
    const r = runWithStdin(['hook-capture', 'stop'], '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
});

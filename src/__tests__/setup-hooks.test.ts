/**
 * setupClaudeHooks - the hook wiring written into .claude/settings.json.
 *
 * The capture pipeline rides Claude Code lifecycle hooks. A long headless
 * `gipity claude -p` run that is killed/crashes before clean exit used to lose
 * its ENTIRE transcript, because Stop/SessionEnd (the only flush points) fire
 * only on a clean exit. The fix flushes incrementally on PostToolUse too.
 *
 * PostToolUse is shared with the file-sync hook, so the merge must KEEP BOTH
 * entries - a naive spread-overwrite would silently drop one. These tests pin
 * that, and that all the lifecycle capture events are wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupClaudeHooks } from '../setup.js';

function withTempCwd(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gipity-hooks-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

function readHooks(dir: string): Record<string, any[]> {
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
  return settings.hooks as Record<string, any[]>;
}

test('PostToolUse keeps BOTH the file-sync and capture entries (merge, not overwrite)', () => {
  withTempCwd((dir) => {
    setupClaudeHooks();
    const hooks = readHooks(dir);
    const ptu = hooks.PostToolUse;
    assert.ok(Array.isArray(ptu), 'PostToolUse is present');
    assert.equal(ptu.length, 2, 'has exactly two entries (file-sync + capture)');

    const cmds = ptu.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
    assert.ok(cmds.some((c: string) => c.includes('gipity') && c.includes('push')), 'file-sync push entry survived');
    assert.ok(cmds.some((c: string) => c.includes('post-tool-use')), 'capture flush entry was added');
  });
});

test('all capture lifecycle events are wired to the runner', () => {
  withTempCwd((dir) => {
    setupClaudeHooks();
    const hooks = readHooks(dir);
    for (const [event, arg] of [
      ['SessionStart', 'session-start'],
      ['Stop', 'stop'],
      ['SubagentStop', 'subagent-stop'],
      ['SessionEnd', 'session-end'],
    ] as const) {
      const cmds = (hooks[event] ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
      assert.ok(cmds.some((c: string) => c.includes(arg)), `${event} → ${arg} wired`);
    }
  });
});

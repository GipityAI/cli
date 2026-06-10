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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { setupClaudeHooks, resolveCaptureRunnerPath } from '../setup.js';

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

// `gipity uninstall` wipes ~/.gipity/local/ but leaves project settings
// pointing at the runner inside it; a bare `node <missing-path>` then shows
// up as a "Stop hook error" in the user's next Claude Code session. The
// command must resolve the runner at fire time and exit 0 silently when it
// is gone everywhere.
test('capture hook command exits 0 silently when the runner file is missing', () => {
  withTempCwd((dir) => {
    setupClaudeHooks();
    const hooks = readHooks(dir);
    const stopCmd: string = hooks.Stop[0].hooks[0].command;

    // Point the baked path at a file that does not exist, and point home at
    // the temp dir so the ~/.gipity/local/ fallback misses too.
    const gone = join(dir, 'gone', 'capture-runner.js');
    const cmd = stopCmd.replace(JSON.stringify(resolveCaptureRunnerPath()), JSON.stringify(gone));
    assert.notEqual(cmd, stopCmd, 'baked runner path was substituted');

    const r = spawnSync(cmd, {
      shell: true,
      input: '{}',
      encoding: 'utf-8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
    });
    assert.equal(r.status, 0, `exit 0, got ${r.status} (stderr: ${r.stderr})`);
    assert.equal(r.stderr.trim(), '', 'no error output');
  });
});

// And when the runner DOES exist, the launcher must actually exec it,
// passing args + stdin through.
test('capture hook command runs the runner when present', () => {
  withTempCwd((dir) => {
    setupClaudeHooks();
    const hooks = readHooks(dir);
    const stopCmd: string = hooks.Stop[0].hooks[0].command;

    // Substitute a stub runner that proves it ran with the right args.
    const stub = join(dir, 'stub-runner.js');
    writeFileSync(stub, "console.log('RAN ' + process.argv.slice(2).join(' '));");
    const cmd = stopCmd.replace(JSON.stringify(resolveCaptureRunnerPath()), JSON.stringify(stub));

    const r = spawnSync(cmd, {
      shell: true,
      input: '{}',
      encoding: 'utf-8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
    });
    assert.equal(r.status, 0, `exit 0, got ${r.status} (stderr: ${r.stderr})`);
    assert.equal(r.stdout.trim(), 'RAN claude-code stop');
  });
});

/**
 * applyAgyHooks - the pure merge that produces a project's .agents/hooks.json
 * (Antigravity file-sync + session-capture integration). Unlike Codex's
 * per-entry merge, our whole contribution lives under one named key
 * ('gipity'), so a re-run replaces it wholesale; any other named hook block
 * - the user's own, or another tool's - is preserved untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgyHooks, AGENT_HOOKS_DIR } from '../setup.js';

test('fresh file gets PostToolUse/Stop (wrapper) groups, and NO PreToolUse', () => {
  const out = applyAgyHooks(null);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  const block = parsed.gipity;

  // Deliberately no PreToolUse: Gipity only observes/reacts (capture + sync),
  // it never gates tool calls - a PreToolUse hook answering "allow" would
  // override agy's own approval prompt for every tool, not just writes.
  assert.equal(block.PreToolUse, undefined);

  // PostToolUse/Stop route through the staged wrapper via launch.sh.
  assert.equal(block.PostToolUse.length, 1);
  assert.equal(block.PostToolUse[0].matcher, '.*');
  const postCmd = block.PostToolUse[0].hooks[0].command;
  assert.ok(postCmd.includes(AGENT_HOOKS_DIR));
  assert.ok(postCmd.includes('agy-hooks.cjs'));
  assert.ok(postCmd.endsWith('post-tool-use'));

  // Stop is FLAT in agy's schema - a handler object directly, NOT wrapped in
  // {matcher, hooks} like PreToolUse/PostToolUse. Confirmed live: a wrapped
  // Stop entry silently invalidates the WHOLE named block - PostToolUse
  // stops firing too, with no error from agy. Regression-guard both shapes.
  assert.equal(block.Stop.length, 1);
  assert.equal(block.Stop[0].matcher, undefined);
  assert.equal(block.Stop[0].hooks, undefined, 'Stop must not be {hooks:[...]}-wrapped');
  const stopCmd = block.Stop[0].command;
  assert.ok(stopCmd.includes(AGENT_HOOKS_DIR));
  assert.ok(stopCmd.endsWith('stop'));
});

test('re-run is a no-op once our block is current', () => {
  const first = applyAgyHooks(null)!;
  assert.equal(applyAgyHooks(first), null);
});

test('an older/different-shaped gipity block gets replaced wholesale', () => {
  // Stands in for an older CLI version's shape - e.g. one that still
  // registered a (since-removed) PreToolUse group.
  const stale = JSON.stringify({ gipity: { PreToolUse: [{ matcher: '.*', hooks: [] }] } });
  const out = applyAgyHooks(stale)!;
  assert.ok(out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.gipity.PreToolUse, undefined);
  assert.ok(parsed.gipity.PostToolUse);
  assert.ok(parsed.gipity.Stop);
});

test('other named hook blocks - the user\'s own, or another tool\'s - are preserved', () => {
  const user = JSON.stringify({
    'my-lint-hook': {
      PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }],
    },
  });
  const out = applyAgyHooks(user)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed['my-lint-hook'].PostToolUse[0].hooks[0].command, './lint.sh');
  assert.ok(parsed.gipity.PostToolUse);
  assert.ok(parsed.gipity.Stop);
});

test('an unparseable user file is left untouched', () => {
  assert.equal(applyAgyHooks('{ not json'), null);
});

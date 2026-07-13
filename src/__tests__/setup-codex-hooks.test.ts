/**
 * applyCodexHooks - the pure merge that produces a project's .codex/hooks.json
 * (Codex file-sync integration). Same contract as the Claude settings merge:
 * add the Gipity groups, never disturb user-authored hooks, no-op when ours
 * are already present, and leave unparseable user files alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCodexHooks, AGENT_HOOKS_DIR } from '../setup.js';

test('fresh file gets push + pull groups pointing at the agent-hooks scripts', () => {
  const out = applyCodexHooks(null);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  const post = parsed.hooks.PostToolUse;
  const prompt = parsed.hooks.UserPromptSubmit;
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Edit|Write');
  assert.ok(post[0].hooks[0].command.includes(AGENT_HOOKS_DIR));
  assert.ok(post[0].hooks[0].command.includes('sync-push.cjs'));
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0].matcher, undefined); // UserPromptSubmit rejects matchers
  assert.ok(prompt[0].hooks[0].command.includes('sync-pull.cjs'));
});

test('re-run is a no-op once both groups exist', () => {
  const first = applyCodexHooks(null)!;
  assert.equal(applyCodexHooks(first), null);
});

test('user-authored hooks are preserved and ours appended', () => {
  const user = JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-logger.sh' }] }],
    },
  });
  const out = applyCodexHooks(user)!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.hooks.PostToolUse.length, 2);
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].command, 'my-logger.sh');
  assert.ok(parsed.hooks.PostToolUse[1].hooks[0].command.includes('sync-push.cjs'));
  assert.equal(parsed.hooks.UserPromptSubmit.length, 1);
});

test('a partial install (push present, pull missing) adds only the missing group', () => {
  const first = JSON.parse(applyCodexHooks(null)!);
  delete first.hooks.UserPromptSubmit;
  const out = applyCodexHooks(JSON.stringify(first))!;
  const parsed = JSON.parse(out);
  assert.equal(parsed.hooks.PostToolUse.length, 1);
  assert.equal(parsed.hooks.UserPromptSubmit.length, 1);
});

test('an unparseable user file is left untouched', () => {
  assert.equal(applyCodexHooks('{ not json'), null);
});

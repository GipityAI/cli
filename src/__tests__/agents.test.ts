/**
 * RemoteAgentAdapter registry - argv snapshots. The Claude snapshots are the
 * load-bearing ones: the relay daemon's dispatch path is the hottest relay
 * code, and the adapter must keep producing exactly the argv the daemon's
 * old literal produced (['-p', msg, '--permission-mode', 'bypassPermissions']
 * + the stream flags spawnGipityClaude appends). If a Claude snapshot here
 * needs changing, you are changing the relay wire behavior - be sure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ADAPTERS, AGENT_KEYS, getAdapter, getAdapterBySource } from '../agents/index.js';

describe('agent adapter registry', () => {
  it('exposes claude, codex, grok, agy in picker order (claude first = default)', () => {
    assert.deepEqual(AGENT_KEYS, ['claude', 'codex', 'grok', 'agy']);
  });

  it('maps CLI keys and server sources to the same adapters', () => {
    assert.equal(getAdapter('claude').source, 'claude_code');
    assert.equal(getAdapterBySource('claude_code').key, 'claude');
    assert.equal(getAdapterBySource('codex').key, 'codex');
    assert.equal(getAdapterBySource('grok').key, 'grok');
    assert.equal(getAdapterBySource('agy').key, 'agy');
  });

  it('throws loudly on unknown keys/sources (no silent Claude fallback)', () => {
    assert.throws(() => getAdapter('cursor'), /Unknown agent/);
    assert.throws(() => getAdapterBySource('cursor'), /No agent adapter/);
  });

  it('every adapter names an install hint and a display/provider pair', () => {
    for (const a of AGENT_ADAPTERS) {
      assert.ok(a.installHint.length > 0, a.key);
      assert.ok(a.displayName && a.providerName, a.key);
    }
  });
});

describe('claude argv snapshots (relay wire behavior)', () => {
  const claude = getAdapter('claude');

  it('headless dispatch argv matches the daemon literal it replaced', () => {
    assert.deepEqual(
      claude.buildHeadlessArgs({ message: 'hi', bypassApprovals: true }),
      ['-p', 'hi', '--permission-mode', 'bypassPermissions'],
    );
  });

  it('resume + model + stream flags', () => {
    assert.deepEqual(
      claude.buildHeadlessArgs({ message: 'go', resume: 'sid-1', model: 'opus', bypassApprovals: true, jsonStream: true }),
      ['-p', 'go', '--permission-mode', 'bypassPermissions', '--model', 'opus', '--resume', 'sid-1',
        '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
    );
  });

  it('interactive argv is empty by default (plain `claude`)', () => {
    assert.deepEqual(claude.buildInteractiveArgs({}), []);
    assert.deepEqual(claude.buildInteractiveArgs({ model: 'opus', resume: 's' }), ['--model', 'opus', '--resume', 's']);
  });

  it('reads session_id off stream events', () => {
    assert.equal(claude.sessionIdFromStreamEvent({ type: 'system', subtype: 'init', session_id: 'abc' }), 'abc');
    assert.equal(claude.sessionIdFromStreamEvent({ type: 'assistant' }), null);
  });
});

describe('codex argv', () => {
  const codex = getAdapter('codex');

  it('headless fresh run uses exec + narrow sandbox bypass (never --yolo)', () => {
    const args = codex.buildHeadlessArgs({ message: 'do it', bypassApprovals: true });
    assert.deepEqual(args.slice(0, 2), ['exec', 'do it']);
    assert.ok(args.includes('-s') && args.includes('workspace-write'));
    assert.ok(args.includes('--dangerously-bypass-hook-trust'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.some(a => a.includes('network_access=true')));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('resume goes through exec resume <sid>', () => {
    const args = codex.buildHeadlessArgs({ message: 'more', resume: 'thread-1' });
    assert.deepEqual(args.slice(0, 4), ['exec', 'resume', 'thread-1', 'more']);
  });

  it('session id comes from thread.started', () => {
    assert.equal(codex.sessionIdFromStreamEvent({ type: 'thread.started', thread_id: 't1' }), 't1');
    assert.equal(codex.sessionIdFromStreamEvent({ type: 'item.completed' }), null);
  });

  it('hooks are unsupported on Windows', () => {
    assert.equal(codex.hooksSupportedOnPlatform('win32'), false);
    assert.equal(codex.hooksSupportedOnPlatform('linux'), true);
  });
});

describe('grok argv', () => {
  const grok = getAdapter('grok');

  it('headless uses -p with --always-approve for bypass', () => {
    assert.deepEqual(
      grok.buildHeadlessArgs({ message: 'fix', bypassApprovals: true }),
      ['-p', 'fix', '--always-approve'],
    );
  });

  it('resume + model + stream', () => {
    assert.deepEqual(
      grok.buildHeadlessArgs({ message: 'm', resume: 'g1', model: 'grok-4.5', jsonStream: true }),
      ['-p', 'm', '--model', 'grok-4.5', '--resume', 'g1', '--output-format', 'streaming-json'],
    );
  });

  it('session id comes from ACP session/update params', () => {
    assert.equal(grok.sessionIdFromStreamEvent({ method: 'session/update', params: { sessionId: 's9' } }), 's9');
    assert.equal(grok.sessionIdFromStreamEvent({}), null);
  });
});

describe('agy argv', () => {
  const agy = getAdapter('agy');

  it('fresh headless run passes --new-project (never bare cwd)', () => {
    assert.deepEqual(
      agy.buildHeadlessArgs({ message: 'do it', bypassApprovals: true }),
      ['-p', 'do it', '--new-project', '--dangerously-skip-permissions'],
    );
  });

  it('resume passes --conversation <id>, never --continue', () => {
    const args = agy.buildHeadlessArgs({ message: 'more', resume: 'conv-1' });
    assert.deepEqual(args, ['-p', 'more', '--conversation', 'conv-1']);
  });

  it('translates a known LLM_MODELS canonical id to agy\'s spaced display string', () => {
    const args = agy.buildHeadlessArgs({ message: 'm', model: 'gemini-3.1-pro-preview', bypassApprovals: true });
    assert.deepEqual(args, ['-p', 'm', '--new-project', '--model', 'Gemini 3.1 Pro (High)', '--dangerously-skip-permissions']);
  });

  it('passes an unrecognized model string straight through (agy\'s own format, or agy rejects it)', () => {
    const args = agy.buildHeadlessArgs({ message: 'm', model: 'Gemini 3.1 Pro (High)' });
    assert.deepEqual(args, ['-p', 'm', '--new-project', '--model', 'Gemini 3.1 Pro (High)']);
  });

  it('interactive argv mirrors the fresh/resume + model rules', () => {
    assert.deepEqual(agy.buildInteractiveArgs({}), ['--new-project']);
    assert.deepEqual(agy.buildInteractiveArgs({ resume: 'conv-2' }), ['--conversation', 'conv-2']);
    assert.deepEqual(
      agy.buildInteractiveArgs({ model: 'gemini-3.5-flash' }),
      ['--new-project', '--model', 'Gemini 3.5 Flash (Medium)'],
    );
  });

  it('has no JSON stream to read a session id from', () => {
    assert.equal(agy.sessionIdFromStreamEvent({ conversationId: 'x' }), null);
    assert.equal(agy.daemonStreamCapture, false);
  });

  it('hooks fire in both interactive and headless mode (POSIX only, like Codex)', () => {
    assert.equal(agy.hooksSupportedOnPlatform('darwin'), true);
    assert.equal(agy.hooksSupportedOnPlatform('linux'), true);
    assert.equal(agy.hooksSupportedOnPlatform('win32'), false);
  });
});

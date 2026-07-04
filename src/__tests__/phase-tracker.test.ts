/**
 * PhaseTracker: derives "what is Claude doing" (thinking / responding /
 * tool / retry / finishing) purely from parsed stream-json events, feeding
 * the web CLI's live progress line. Pure state machine - no spawn, no
 * network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PhaseTracker, toolHint } from '../relay/daemon.js';

const assistantWith = (blocks: any[]) => ({ type: 'assistant', message: { content: blocks } });
const resultFor = (ids: string[]) => ({
  type: 'user',
  message: { content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
});

describe('PhaseTracker', () => {
  it('starts in starting, thinking_tokens flips to thinking', () => {
    const t = new PhaseTracker();
    assert.equal(t.phase, 'starting');
    t.note({ type: 'system', subtype: 'thinking_tokens' });
    assert.equal(t.phase, 'thinking');
  });

  it('a text-only assistant event means responding', () => {
    const t = new PhaseTracker();
    t.note(assistantWith([{ type: 'text', text: 'hello' }]));
    assert.equal(t.phase, 'responding');
  });

  it('tool_use opens the tool phase with name + hint; tool_result closes it', () => {
    const t = new PhaseTracker();
    t.note(assistantWith([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }]));
    assert.equal(t.phase, 'tool');
    assert.equal(t.currentTool()?.name, 'Bash');
    assert.equal(t.currentTool()?.hint, 'npm run build');
    t.note(resultFor(['t1']));
    assert.equal(t.phase, 'thinking'); // results feed the next model turn
    assert.equal(t.currentTool(), null);
  });

  it('parallel tool calls: currentTool is the most recent still-open one', () => {
    const t = new PhaseTracker();
    t.note(assistantWith([
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x.ts' } },
      { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'foo' } },
    ]));
    assert.equal(t.currentTool()?.name, 'Grep');
    t.note(resultFor(['b']));
    assert.equal(t.phase, 'tool'); // 'a' still open
    assert.equal(t.currentTool()?.name, 'Read');
  });

  it('thinking_tokens during an open tool does NOT hide the tool phase', () => {
    const t = new PhaseTracker();
    t.note(assistantWith([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    t.note({ type: 'system', subtype: 'thinking_tokens' });
    assert.equal(t.phase, 'tool');
  });

  it('api_retry sets retry info; the next assistant event clears it', () => {
    const t = new PhaseTracker();
    t.note({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5 });
    assert.equal(t.phase, 'retry');
    assert.deepEqual(t.retry, { attempt: 2, max: 5 });
    t.note(assistantWith([{ type: 'text', text: 'recovered' }]));
    assert.equal(t.retry, null);
    assert.equal(t.phase, 'responding');
  });

  it('result event means finishing', () => {
    const t = new PhaseTracker();
    t.note({ type: 'result', subtype: 'success' });
    assert.equal(t.phase, 'finishing');
  });
});

describe('toolHint', () => {
  it('Bash → the command; file tools → the path; else a signature field', () => {
    assert.equal(toolHint('Bash', { command: 'ls -la' }), 'ls -la');
    assert.equal(toolHint('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(toolHint('Grep', { pattern: 'TODO' }), 'TODO');
    assert.equal(toolHint('WebSearch', { query: 'weather' }), 'weather');
    assert.equal(toolHint('Mystery', { blob: { x: 1 } }), undefined);
  });
});

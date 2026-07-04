/**
 * Pure unit tests for the relay's stream-json parsing pipeline. No
 * daemon, no spawn, no network - just the `parseEvent`, `mapEventToEntries`,
 * and `createLineSplitter` logic. Uses node's built-in test runner.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEvent,
  mapEventToEntries,
  createLineSplitter,
  type IngestEntry,
} from '../relay/stream-json.js';

describe('parseEvent', () => {
  it('parses a well-formed system init event', () => {
    const line = '{"type":"system","subtype":"init","session_id":"abc","cwd":"/tmp"}';
    const evt = parseEvent(line);
    assert.equal(evt?.type, 'system');
    assert.equal((evt as any).subtype, 'init');
    assert.equal((evt as any).session_id, 'abc');
  });

  it('returns null for empty / whitespace input', () => {
    assert.equal(parseEvent(''), null);
    assert.equal(parseEvent('   \t  '), null);
    assert.equal(parseEvent('\n'), null);
  });

  it('invokes onWarn with "bad_json" on malformed JSON', () => {
    const warnings: Array<{ reason: string; snippet: string }> = [];
    const out = parseEvent('{not json', (reason, snippet) => {
      warnings.push({ reason, snippet });
    });
    assert.equal(out, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, 'bad_json');
    assert.match(warnings[0].snippet, /not json/);
  });

  it('invokes onWarn with "bad_shape" when type field is missing', () => {
    const warnings: Array<{ reason: string; snippet: string }> = [];
    const out = parseEvent('{"foo":"bar"}', (reason) => warnings.push({ reason, snippet: '' }));
    assert.equal(out, null);
    assert.equal(warnings[0].reason, 'bad_shape');
  });

  it('invokes onWarn with "too_long" on absurdly long lines', () => {
    const huge = '{"type":"assistant","padding":"' + 'x'.repeat(3 * 1024 * 1024) + '"}';
    const warnings: string[] = [];
    const out = parseEvent(huge, (reason) => warnings.push(reason));
    assert.equal(out, null);
    assert.equal(warnings[0], 'too_long');
  });

  it('does not throw when onWarn is omitted', () => {
    assert.equal(parseEvent('{bad'), null);
    assert.equal(parseEvent('{"no_type":true}'), null);
  });
});

describe('mapEventToEntries', () => {
  it('system.init → one attach entry', () => {
    const entries = mapEventToEntries({
      type: 'system', subtype: 'init',
      session_id: 'sid-123', cwd: '/home/u/proj',
    } as any);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'attach');
    assert.equal((entries[0] as any).session_id, 'sid-123');
    assert.equal((entries[0] as any).cwd, '/home/u/proj');
  });

  it('assistant with only text blocks → one assistant entry', () => {
    const entries = mapEventToEntries({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'World' }] },
    } as any);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'assistant');
    assert.equal((entries[0] as any).text, 'Hello\nWorld');
    assert.equal((entries[0] as any).blocks.length, 2);
  });

  it('assistant with tool_use → assistant entry AND per-tool tool_use entry', () => {
    const entries = mapEventToEntries({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/x' } },
      ] },
    } as any);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].kind, 'assistant');
    assert.equal(entries[1].kind, 'tool_use');
    assert.equal((entries[1] as any).tool_use_id, 'toolu_a');
    assert.equal((entries[1] as any).tool_name, 'Bash');
    assert.deepEqual((entries[1] as any).tool_input, { command: 'ls' });
    assert.equal(entries[2].kind, 'tool_use');
    assert.equal((entries[2] as any).tool_use_id, 'toolu_b');
  });

  it('user.tool_result → tool_result entry per block', () => {
    const entries = mapEventToEntries({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'file1\nfile2' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'contents', is_error: true },
      ] },
    } as any);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, 'tool_result');
    assert.equal((entries[0] as any).tool_use_id, 'toolu_a');
    assert.equal((entries[0] as any).content, 'file1\nfile2');
    assert.equal((entries[0] as any).is_error, false);
    assert.equal((entries[1] as any).is_error, true);
  });

  it('unknown event type → no entries', () => {
    const entries = mapEventToEntries({ type: 'result', subtype: 'success' } as any);
    assert.equal(entries.length, 0);
  });

  it('assistant with empty content → no entries', () => {
    const entries = mapEventToEntries({ type: 'assistant', message: { content: [] } } as any);
    assert.equal(entries.length, 0);
  });
});

describe('createLineSplitter', () => {
  it('emits each complete line individually', () => {
    const lines: string[] = [];
    const s = createLineSplitter(l => lines.push(l));
    s.push('one\ntwo\nthree\n');
    assert.deepEqual(lines, ['one', 'two', 'three']);
  });

  it('holds a partial trailing chunk until the next newline', () => {
    const lines: string[] = [];
    const s = createLineSplitter(l => lines.push(l));
    s.push('partial');
    assert.deepEqual(lines, []);
    s.push(' more\ndone\n');
    assert.deepEqual(lines, ['partial more', 'done']);
  });

  it('handles JSON event split across two chunks', () => {
    const lines: string[] = [];
    const s = createLineSplitter(l => lines.push(l));
    s.push('{"type":"assistant","message":{"cont');
    s.push('ent":[{"type":"text","text":"hi"}]}}\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, 'assistant');
  });

  it('flush() emits any unterminated trailing line at EOF', () => {
    const lines: string[] = [];
    const s = createLineSplitter(l => lines.push(l));
    s.push('tail-no-newline');
    s.flush();
    assert.deepEqual(lines, ['tail-no-newline']);
  });

  it('accepts Buffer chunks', () => {
    const lines: string[] = [];
    const s = createLineSplitter(l => lines.push(l));
    s.push(Buffer.from('alpha\n'));
    s.push(Buffer.from('beta\n'));
    assert.deepEqual(lines, ['alpha', 'beta']);
  });

  it('force-drains the buffer when it grows past the safety cap without a newline', () => {
    const lines: string[] = [];
    const s = createLineSplitter(l => lines.push(l));
    // Push > 4MB of non-newline data in chunks. The splitter should
    // force-flush rather than grow unboundedly.
    const chunk = 'x'.repeat(512 * 1024); // 512 KB
    for (let i = 0; i < 10; i++) s.push(chunk);
    // At least one force-drain should have fired; total size > 4MB means
    // the splitter emitted the overflow as a single oversized "line".
    assert.ok(lines.length >= 1, 'expected at least one force-drain');
    // Subsequent newline still emits remaining buffer as a proper line.
    s.push('\n');
    s.flush();
    // No unbounded memory: total content of emitted lines matches input.
    const total = lines.reduce((n, l) => n + l.length, 0);
    assert.equal(total, 10 * chunk.length);
  });
});

describe('mapEventToEntries - round trip shape matches IngestEntry union', () => {
  it('every emitted entry has a kind field from the declared union', () => {
    const validKinds: IngestEntry['kind'][] = [
      'attach', 'prompt', 'assistant', 'tool_use', 'tool_result', 'compact', 'system',
    ];
    const sample = mapEventToEntries({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ] },
    } as any);
    for (const e of sample) assert.ok(validKinds.includes(e.kind));
  });
});

describe('mapEventToEntries - Phase 2 capture additions', () => {
  it('attach carries model/tools_count/mcp_count from the init event', () => {
    const [attach] = mapEventToEntries({
      type: 'system', subtype: 'init', session_id: 's1', cwd: '/p',
      model: 'claude-x', tools: ['Bash', 'Read', 'Write'], mcp_servers: [{ name: 'pg' }],
    } as any);
    assert.equal(attach.kind, 'attach');
    assert.equal((attach as any).model, 'claude-x');
    assert.equal((attach as any).tools_count, 3);
    assert.equal((attach as any).mcp_count, 1);
  });

  it('system/compact_boundary → compact entry with trigger', () => {
    const entries = mapEventToEntries({
      type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' },
    } as any);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'compact');
    assert.equal((entries[0] as any).trigger, 'auto');
  });

  it('assistant source_uuid sequences per-block events sharing a message id', () => {
    // Assistant events arrive per content block with the SAME message id
    // (verified against claude CLI v2.1.199); a bare-id dedup key would
    // drop every block after the first.
    const msgSeq = new Map<string, number>();
    const [first] = mapEventToEntries({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'hmm' }] },
    } as any, { msgSeq });
    const [second] = mapEventToEntries({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'answer' }] },
    } as any, { msgSeq });
    assert.equal((first as any).source_uuid, 'msg_1#0');
    assert.equal((second as any).source_uuid, 'msg_1#1');
  });

  it('tool_use entries always carry their tool_use_id as source_uuid', () => {
    const entries = mapEventToEntries({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_z', name: 'Bash', input: {} }] },
    } as any);
    const tu = entries.find(e => e.kind === 'tool_use');
    assert.equal((tu as any).source_uuid, 'toolu_z');
  });

  it('onUnmapped fires for unknown events but not for known noise', () => {
    const seen: string[] = [];
    const ctx = { onUnmapped: (t: string, s?: string) => seen.push(s ? `${t}/${s}` : t) };
    mapEventToEntries({ type: 'system', subtype: 'brand_new_thing' } as any, ctx);
    mapEventToEntries({ type: 'mystery_event' } as any, ctx);
    mapEventToEntries({ type: 'system', subtype: 'thinking_tokens' } as any, ctx);
    mapEventToEntries({ type: 'system', subtype: 'hook_started' } as any, ctx);
    mapEventToEntries({ type: 'rate_limit_event' } as any, ctx);
    assert.deepEqual(seen, ['system/brand_new_thing', 'mystery_event']);
  });

  it('back-compat: a bare toolNames Map still threads tool names', () => {
    const toolNames = new Map<string, string>();
    mapEventToEntries({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't9', name: 'Grep', input: {} }] },
    } as any, toolNames);
    const [result] = mapEventToEntries({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'x' }] },
    } as any, toolNames);
    assert.equal((result as any).tool_name, 'Grep');
  });
});

describe('mapEventToEntries - subagent attribution (Phase 6)', () => {
  it('stamps parent_tool_use_id on subagent assistant + tool_use entries', () => {
    const entries = mapEventToEntries({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent99',
      message: { id: 'msg_sub', content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'pwd' } },
      ] },
    } as any);
    const assistant = entries.find(e => e.kind === 'assistant');
    const toolUse = entries.find(e => e.kind === 'tool_use');
    assert.equal((assistant as any).parent_tool_use_id, 'toolu_parent99');
    assert.equal((toolUse as any).parent_tool_use_id, 'toolu_parent99');
  });

  it('stamps parent_tool_use_id on subagent tool_result entries', () => {
    const [result] = mapEventToEntries({
      type: 'user',
      parent_tool_use_id: 'toolu_parent99',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: '/x' }] },
    } as any);
    assert.equal((result as any).parent_tool_use_id, 'toolu_parent99');
  });

  it('top-level (no parent) entries leave parent_tool_use_id undefined', () => {
    const entries = mapEventToEntries({
      type: 'assistant',
      message: { id: 'msg_top', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    } as any);
    for (const e of entries) assert.equal((e as any).parent_tool_use_id, undefined);
  });
});

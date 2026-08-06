/**
 * Unit tests for the Claude Code transcript → ingest mapper used by the
 * capture hook runner. Pure function tests, no file I/O, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  transcriptLineToEntries,
  parseTranscript,
} from '../capture/sources/claude-code.js';

describe('transcriptLineToEntries', () => {
  it('skips queue-operation, summary, sidechain, and envelope-only lines', () => {
    assert.deepEqual(transcriptLineToEntries({ type: 'queue-operation', uuid: 'a' }), []);
    assert.deepEqual(transcriptLineToEntries({ type: 'summary', uuid: 'b' }), []);
    assert.deepEqual(transcriptLineToEntries({ type: 'user', uuid: 'c', isSidechain: true, message: { content: 'hi' } }), []);
    assert.deepEqual(transcriptLineToEntries({ type: 'user', uuid: 'd', toolUseResult: { foo: 1 } }), []);
  });

  it('skips lines missing a uuid', () => {
    assert.deepEqual(transcriptLineToEntries({ type: 'user', message: { content: 'hi' } }), []);
  });

  it('maps a string-content user message to a prompt entry tagged with uuid', () => {
    const out = transcriptLineToEntries({ type: 'user', uuid: 'u1', message: { content: 'what is 2+2' } });
    assert.deepEqual(out, [{ kind: 'prompt', prompt: 'what is 2+2', source_uuid: 'u1' }]);
  });

  it('maps a user message with tool_result blocks to one tool_result per block', () => {
    const out = transcriptLineToEntries({
      type: 'user',
      uuid: 'u2',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool_a', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tool_b', content: 'fail', is_error: true },
        ],
      },
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'tool_result');
    assert.equal((out[0] as any).tool_use_id, 'tool_a');
    assert.equal((out[0] as any).source_uuid, 'u2');
    assert.equal((out[1] as any).is_error, true);
  });

  it('maps an assistant message with text + tool_use blocks', () => {
    const out = transcriptLineToEntries({
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          { type: 'text', text: 'running:' },
          { type: 'tool_use', id: 'tool_a', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'done' },
        ],
      },
    });
    // One assistant entry (with joined text + full blocks) + one tool_use entry
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'assistant');
    assert.equal((out[0] as any).text, 'running:\ndone');
    // The primary entry keeps the bare line uuid; the sibling tool_use gets a
    // deterministic #N suffix so the server's (conversation_id, source_uuid)
    // dedup index does NOT drop it. Without this, the tool row lost its name.
    assert.equal((out[0] as any).source_uuid, 'a1');
    assert.equal(out[1].kind, 'tool_use');
    assert.equal((out[1] as any).tool_name, 'Bash');
    assert.equal((out[1] as any).source_uuid, 'a1#1');
  });

  it('captures token usage + model + stop_reason onto the assistant entry', () => {
    const out = transcriptLineToEntries({
      type: 'assistant',
      uuid: 'a-usage',
      message: {
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1200, output_tokens: 345 },
        content: [{ type: 'text', text: 'done' }],
      },
    });
    assert.equal(out[0].kind, 'assistant');
    assert.equal((out[0] as any).input_tokens, 1200);
    assert.equal((out[0] as any).output_tokens, 345);
    assert.equal((out[0] as any).model, 'claude-opus-4-8');
    assert.equal((out[0] as any).stop_reason, 'end_turn');
  });

  it('omits usage fields when the assistant message has none', () => {
    const out = transcriptLineToEntries({
      type: 'assistant', uuid: 'a-nousage',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    assert.equal(out[0].kind, 'assistant');
    assert.equal((out[0] as any).input_tokens, undefined);
    assert.equal((out[0] as any).model, undefined);
  });

  it('gives every entry from one line a UNIQUE source_uuid (dedup-collision regression)', () => {
    // An assistant turn with text + two parallel tool calls. All three entries
    // derive from the same transcript line. Before the fix they shared the bare
    // line uuid and the server dropped both tool_use rows on ON CONFLICT.
    const out = transcriptLineToEntries({
      type: 'assistant',
      uuid: 'a9',
      message: {
        content: [
          { type: 'text', text: 'doing two things' },
          { type: 'tool_use', id: 'tool_x', name: 'Read', input: { file: 'a' } },
          { type: 'tool_use', id: 'tool_y', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    assert.equal(out.length, 3);
    const uuids = out.map(e => (e as any).source_uuid);
    assert.deepEqual(uuids, ['a9', 'a9#1', 'a9#2']);
    // The invariant that matters: no two entries collide.
    assert.equal(new Set(uuids).size, out.length);
  });
});

describe('parseTranscript', () => {
  const user1 = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hello' } });
  const asst1 = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } });
  const user2 = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'again' } });
  const asst2 = JSON.stringify({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'yes' }] } });
  const transcript = [user1, asst1, user2, asst2].join('\n');

  it('emits every entry when watermark is null', () => {
    const r = parseTranscript(transcript, null);
    assert.equal(r.entries.length, 4);
    assert.equal(r.lastUuid, 'a2');
    assert.equal(r.foundWatermark, true);
  });

  it('skips up through the watermark and emits the rest', () => {
    const r = parseTranscript(transcript, 'a1');
    assert.equal(r.entries.length, 2);
    assert.equal((r.entries[0] as any).prompt, 'again');
    assert.equal(r.lastUuid, 'a2');
    assert.equal(r.foundWatermark, true);
  });

  it('reports foundWatermark=false when watermark isn\'t in the transcript', () => {
    const r = parseTranscript(transcript, 'missing-uuid');
    assert.equal(r.foundWatermark, false);
  });

  it('tolerates malformed JSONL lines', () => {
    const junk = transcript + '\n{not json\n' + user2;
    const r = parseTranscript(junk, null);
    // Malformed lines are ignored; duplicate u2 appears twice (dedup is the
    // server's job via source_uuid, not the parser's).
    assert.equal(r.entries.length, 5);
  });
});

describe('parseTranscript usage totals', () => {
  const line = (obj: any) => JSON.stringify(obj);

  it('sums fresh + cache tokens per API message, counting a split message once', () => {
    // One API response split across two transcript lines (one per content
    // block) repeats the same message.id + usage - it must count ONCE.
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
    const t = [
      line({ type: 'user', uuid: 'u1', message: { content: 'go' } }),
      line({ type: 'assistant', uuid: 'a1', message: { id: 'msg_X', content: [{ type: 'text', text: 'part 1' }], usage } }),
      line({ type: 'assistant', uuid: 'a2', message: { id: 'msg_X', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage } }),
      line({ type: 'assistant', uuid: 'a3', message: { id: 'msg_Y', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 7 } } }),
    ].join('\n');
    const r = parseTranscript(t, null);
    assert.deepEqual(r.usage, { tokensIn: 10 + 1000 + 100 + 5, tokensOut: 20 + 7 });
  });

  it('counts usage only past the watermark and skips sidechain lines', () => {
    const t = [
      line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'old' }], usage: { input_tokens: 999, output_tokens: 999 } } }),
      line({ type: 'assistant', uuid: 'a2', isSidechain: true, message: { id: 'm2', content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 500, output_tokens: 500 } } }),
      line({ type: 'assistant', uuid: 'a3', message: { id: 'm3', content: [{ type: 'text', text: 'new' }], usage: { input_tokens: 3, output_tokens: 4 } } }),
    ].join('\n');
    const r = parseTranscript(t, 'a1');
    assert.deepEqual(r.usage, { tokensIn: 3, tokensOut: 4 });
  });

  it('counts usage from an assistant line even when it emits no entries', () => {
    // Empty content still carries real token usage.
    const t = line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [], usage: { input_tokens: 8, output_tokens: 2 } } });
    const r = parseTranscript(t, null);
    assert.equal(r.entries.length, 0);
    assert.deepEqual(r.usage, { tokensIn: 8, tokensOut: 2 });
  });
});

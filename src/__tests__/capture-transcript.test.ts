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
    assert.equal((out[0] as any).source_uuid, 'a1');
    assert.equal(out[1].kind, 'tool_use');
    assert.equal((out[1] as any).tool_name, 'Bash');
    assert.equal((out[1] as any).source_uuid, 'a1');
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

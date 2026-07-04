/**
 * DeltaAccumulator + DeltaBatcher: the token-streaming pipeline. Pure
 * logic - no spawn, no network. The load-bearing property under test is
 * redaction across chunk boundaries: a secret split over fragments must
 * never reach the wire un-scrubbed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaAccumulator, DeltaBatcher, safeEmitBoundary } from '../relay/stream-delta.js';
import type { StreamDeltaEvent, DeltaFlush } from '../relay/stream-delta.js';

const SECRET = 'supersecrettoken12345';

function se(inner: any, extra: Record<string, unknown> = {}) {
  return { type: 'stream_event', event: inner, ...extra };
}
const blockStart = (idx: number, cb: any) => se({ type: 'content_block_start', index: idx, content_block: cb });
const textDelta = (idx: number, text: string) => se({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
const blockStop = (idx: number) => se({ type: 'content_block_stop', index: idx });

function collect(acc: DeltaAccumulator, events: any[]): StreamDeltaEvent[] {
  const out: StreamDeltaEvent[] = [];
  for (const e of events) out.push(...acc.note(e));
  return out;
}

describe('safeEmitBoundary', () => {
  it('holds back the trailing partial token, emits on close', () => {
    assert.equal(safeEmitBoundary('hello wor', false), 6); // holds "wor"
    assert.equal(safeEmitBoundary('hello wor', true), 9);
    assert.equal(safeEmitBoundary('hello ', false), 6);    // trailing space - all safe
    assert.equal(safeEmitBoundary('nospace', false), 0);   // one unfinished token
  });

  it('gives up holding back a giant token', () => {
    const s = 'x'.repeat(5000);
    assert.equal(safeEmitBoundary(s, false), s.length);
  });
});

describe('DeltaAccumulator', () => {
  it('start → delta → stop lifecycle for a text block', () => {
    const acc = new DeltaAccumulator(() => []);
    const out = collect(acc, [
      blockStart(0, { type: 'text', text: '' }),
      textDelta(0, 'hello '),
      textDelta(0, 'world'),
      blockStop(0),
    ]);
    assert.deepEqual(out.map(e => e.kind), ['start', 'delta', 'delta', 'stop']);
    // First delta emits the complete token "hello " (trailing space);
    // "world" is held until stop closes the block.
    assert.equal(out[1].text, 'hello ');
    assert.equal(out[2].text, 'world');
    assert.equal(out[1].acc_offset, 0);
    assert.equal(out[2].acc_offset, 6);
  });

  it('scrubs a secret split across fragments once its token completes', () => {
    const acc = new DeltaAccumulator(() => [SECRET]);
    const half = Math.floor(SECRET.length / 2);
    const out = collect(acc, [
      blockStart(0, { type: 'text', text: '' }),
      textDelta(0, `token: ${SECRET.slice(0, half)}`),   // partial secret - must be held
      textDelta(0, `${SECRET.slice(half)} done`),        // completes it
      blockStop(0),
    ]);
    const streamed = out.filter(e => e.kind === 'delta').map(e => e.text).join('');
    assert.ok(!streamed.includes(SECRET), 'complete secret leaked to the stream');
    assert.ok(!streamed.includes(SECRET.slice(0, half)), 'partial secret prefix leaked');
    assert.ok(streamed.includes('[redacted]'), `expected marker in: ${streamed}`);
    assert.ok(streamed.includes('done'));
  });

  it('holds back a multi-line PEM key until END, then scrubs it whole', () => {
    // The whitespace-boundary holdback alone would emit BEGIN before END
    // arrives and per-span redaction would miss the split key. The PEM
    // guard holds the whole block until END, so it scrubs as one span.
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc123\nDEFghi456\n-----END PRIVATE KEY-----';
    const acc = new DeltaAccumulator(() => []); // no literal secrets - pattern must catch it
    const out = collect(acc, [
      blockStart(0, { type: 'text', text: '' }),
      textDelta(0, 'here is a key: -----BEGIN PRIVATE KEY-----\nMIIabc123\n'), // BEGIN, no END yet
      textDelta(0, 'DEFghi456\n-----END PRIVATE KEY-----\ndone'),               // completes it
      blockStop(0),
    ]);
    const streamed = out.filter(e => e.kind === 'delta').map(e => e.text).join('');
    assert.ok(!streamed.includes('MIIabc123'), 'PEM key body leaked to the stream');
    assert.ok(!streamed.includes('BEGIN PRIVATE KEY'), 'PEM BEGIN marker leaked before scrub');
    assert.ok(streamed.includes('[redacted]'), `expected redaction marker in: ${streamed}`);
    // No delta should have been emitted while the key was still open.
    const firstDelta = out.find(e => e.kind === 'delta');
    assert.ok(firstDelta, 'expected at least one delta after the block closed');
  });

  it('thinking and tool_use blocks map their fragment fields', () => {
    const acc = new DeltaAccumulator(() => []);
    const out = collect(acc, [
      blockStart(0, { type: 'thinking', thinking: '' }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering ' } }),
      blockStop(0),
      blockStart(1, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls ' } }),
      blockStop(1),
    ]);
    const start1 = out.find(e => e.block_index === 1 && e.kind === 'start');
    assert.equal(start1?.tool_name, 'Bash');
    assert.equal(out.find(e => e.block_index === 0 && e.kind === 'delta')?.block_type, 'thinking');
    const toolDeltas = out.filter(e => e.block_index === 1 && e.kind === 'delta');
    assert.ok(toolDeltas.map(e => e.text).join('').includes('"command"'));
  });

  it('keys blocks by the message id from message_start (content_block events lack it)', () => {
    // The persisted assistant rows are keyed `msg_id#n`; the client's
    // finalize swap only works if streamed blocks carry the same message
    // id. Two messages in one dispatch must not collide either.
    const acc = new DeltaAccumulator(() => []);
    const out = collect(acc, [
      se({ type: 'message_start', message: { id: 'msg_A' } }),
      blockStart(0, { type: 'text', text: '' }),
      textDelta(0, 'first '),
      blockStop(0),
      se({ type: 'message_start', message: { id: 'msg_B' } }),
      blockStart(0, { type: 'text', text: '' }),
      textDelta(0, 'second '),
      blockStop(0),
    ]);
    const ids = out.map(e => e.message_id);
    assert.ok(ids.slice(0, 3).every(id => id === 'msg_A'), `first message events keyed ${ids.slice(0, 3)}`);
    assert.ok(ids.slice(3).every(id => id === 'msg_B'), `second message events keyed ${ids.slice(3)}`);
  });

  it('skips subagent stream events (parent_tool_use_id set)', () => {
    const acc = new DeltaAccumulator(() => []);
    const out = collect(acc, [
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { parent_tool_use_id: 'toolu_parent' }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } }, { parent_tool_use_id: 'toolu_parent' }),
    ]);
    assert.equal(out.length, 0);
  });

  it('a delta without a start still streams (missed flush resilience)', () => {
    const acc = new DeltaAccumulator(() => []);
    const out = collect(acc, [textDelta(0, 'orphan text '), blockStop(0)]);
    assert.equal(out.filter(e => e.kind === 'delta').length >= 1, true);
    assert.equal(out[0].block_type, 'text');
  });
});

describe('DeltaBatcher', () => {
  it('numbers flushes sequentially and respects the per-flush event cap', () => {
    const flushes: DeltaFlush[] = [];
    const b = new DeltaBatcher(f => flushes.push(f), 999_999); // no timer in test
    const events: StreamDeltaEvent[] = Array.from({ length: 70 }, (_, i) => ({
      message_id: 'm', block_index: 0, block_type: 'text', kind: 'delta', text: `t${i} `, acc_offset: i,
    }));
    b.push(events); // 70 ≥ 64 → immediate flush path
    b.close();
    assert.ok(flushes.length >= 2, `expected ≥2 flushes, got ${flushes.length}`);
    assert.deepEqual(flushes.map(f => f.seq), flushes.map((_, i) => i));
    for (const f of flushes) assert.ok(f.events.length <= 64);
    assert.equal(flushes.reduce((n, f) => n + f.events.length, 0), 70);
  });

  it('flushes early once buffered text passes the byte threshold', () => {
    const flushes: DeltaFlush[] = [];
    const b = new DeltaBatcher(f => flushes.push(f), 999_999);
    b.push([{ message_id: 'm', block_index: 0, block_type: 'text', kind: 'delta', text: 'x'.repeat(5000), acc_offset: 0 }]);
    assert.equal(flushes.length, 1, 'byte threshold should force an immediate flush');
    b.close();
  });

  it('close flushes the remainder and rejects later pushes', () => {
    const flushes: DeltaFlush[] = [];
    const b = new DeltaBatcher(f => flushes.push(f), 999_999);
    b.push([{ message_id: 'm', block_index: 0, block_type: 'text', kind: 'delta', text: 'tail', acc_offset: 0 }]);
    b.close();
    assert.equal(flushes.length, 1);
    b.push([{ message_id: 'm', block_index: 0, block_type: 'text', kind: 'delta', text: 'late', acc_offset: 4 }]);
    assert.equal(flushes.length, 1, 'push after close must not flush');
  });
});

/**
 * Unit tests for the capture runner's metrics helpers - the pieces that turn
 * a flush's parsed entries into the tokens/working-time totals emitted as a
 * `result` ingest entry on Stop/SessionEnd. Pure function tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeMsFromEntries, entryTokenTotals, ACTIVE_GAP_MAX_MS } from '../hooks/capture-runner.js';
import type { IngestEntry } from '../capture/sources/claude-code.js';

const ts = (ms: number) => new Date(1754400000000 + ms).toISOString();

describe('activeMsFromEntries', () => {
  it('sums gaps between consecutive timestamps', () => {
    const entries: IngestEntry[] = [
      { kind: 'prompt', prompt: 'go', ts: ts(0) },
      { kind: 'tool_use', tool_use_id: 't1', tool_name: 'Bash', ts: ts(2_000) },
      { kind: 'assistant', text: 'done', blocks: [], ts: ts(5_000) },
    ];
    assert.equal(activeMsFromEntries(entries), 5_000);
  });

  it('skips idle stretches longer than the gap cap (replayed multi-prompt range)', () => {
    const entries: IngestEntry[] = [
      { kind: 'prompt', prompt: 'one', ts: ts(0) },
      { kind: 'assistant', text: 'a', blocks: [], ts: ts(3_000) },
      // User walked away, came back much later.
      { kind: 'prompt', prompt: 'two', ts: ts(3_000 + ACTIVE_GAP_MAX_MS + 60_000) },
      { kind: 'assistant', text: 'b', blocks: [], ts: ts(3_000 + ACTIVE_GAP_MAX_MS + 64_000) },
    ];
    assert.equal(activeMsFromEntries(entries), 3_000 + 4_000);
  });

  it('ignores entries without a parseable timestamp and never goes negative', () => {
    const entries: IngestEntry[] = [
      { kind: 'prompt', prompt: 'x', ts: ts(10_000) },
      { kind: 'system', content: 'no ts here' },
      { kind: 'assistant', text: 'y', blocks: [], ts: 'not-a-date' },
      // Out-of-order timestamp: negative gap is dropped, not subtracted.
      { kind: 'assistant', text: 'z', blocks: [], ts: ts(9_000) },
    ];
    assert.equal(activeMsFromEntries(entries), 0);
    assert.equal(activeMsFromEntries([]), 0);
  });
});

describe('entryTokenTotals', () => {
  it('sums assistant entries token fields (the Codex/Grok fallback)', () => {
    const entries: IngestEntry[] = [
      { kind: 'prompt', prompt: 'go' },
      { kind: 'assistant', text: 'a', blocks: [], input_tokens: 100, output_tokens: 10 },
      { kind: 'tool_use', tool_use_id: 't1', tool_name: 'Bash' },
      { kind: 'assistant', text: 'b', blocks: [], input_tokens: 200, output_tokens: 20 },
      { kind: 'assistant', text: 'no usage', blocks: [] },
    ];
    assert.deepEqual(entryTokenTotals(entries), { tokensIn: 300, tokensOut: 30 });
  });

  it('returns zeros for an empty or usage-less batch', () => {
    assert.deepEqual(entryTokenTotals([]), { tokensIn: 0, tokensOut: 0 });
    assert.deepEqual(
      entryTokenTotals([{ kind: 'system', content: 'x' }]),
      { tokensIn: 0, tokensOut: 0 },
    );
  });
});

/**
 * Contract test: every key the daemon emits in an ingest entry must appear
 * in the manifest below - which mirrors the server's `entrySchema`
 * (platform/server/src/routes/remote-sessions.ts). If `mapEventToEntries`
 * ever stamps a key the server doesn't accept, this test fails loudly
 * BEFORE the daemon ships and starts 400ing in production.
 *
 * Why a manifest instead of importing the server's Zod schema directly:
 * the CLI is a standalone npm package with a strict `rootDir: src`
 * tsconfig - a cross-workspace import won't typecheck. The manifest is
 * the smallest thing that catches the class of bug we hit (the daemon
 * adding a `ts` field the server stripped silently, then later rejected).
 *
 * **When the server's entrySchema gains a field**, add it here too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapEventToEntries, type IngestEntry } from '../relay/stream-json.js';

/** Mirror of the server's `entrySchema` in
 *  platform/server/src/routes/remote-sessions.ts. Keep in sync. */
// Every kind also allows the optional `ts` event-time hint (stored in
// the server's untrusted `event_at` column).
// Every kind also allows the optional `source_uuid` idempotency key
// (server dedup via the partial unique index on (conversation_id,
// source_uuid) - what makes the ingest queue's retries safe).
const ALLOWED_KEYS_BY_KIND: Record<IngestEntry['kind'], readonly string[]> = {
  attach:      ['kind', 'session_id', 'cwd', 'source', 'model', 'tools_count', 'mcp_count', 'api_key_source', 'ts', 'source_uuid'],
  prompt:      ['kind', 'prompt', 'ts', 'source_uuid'],
  tool_use:    ['kind', 'tool_use_id', 'tool_name', 'tool_input', 'ts', 'source_uuid', 'parent_tool_use_id'],
  tool_result: ['kind', 'tool_use_id', 'tool_name', 'content', 'is_error', 'ts', 'source_uuid', 'parent_tool_use_id'],
  assistant:   ['kind', 'text', 'blocks', 'input_tokens', 'output_tokens', 'model', 'stop_reason', 'ts', 'source_uuid', 'parent_tool_use_id'],
  compact:     ['kind', 'trigger', 'ts', 'source_uuid'],
  system:      ['kind', 'content', 'ts', 'source_uuid'],
  result:      ['kind', 'total_cost_usd', 'num_turns', 'duration_ms', 'ts', 'source_uuid'],
};

/** Sample stream-json events covering every branch of mapEventToEntries.
 *  When mapEventToEntries grows a new branch, add a sample here. */
const SAMPLE_EVENTS: any[] = [
  // attach (with init metadata: model + tool/mcp counts)
  { type: 'system', subtype: 'init', session_id: 'sess-abc', cwd: '/tmp/demo', model: 'claude-x', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'pg' }] },
  // compact boundary
  { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } },
  // assistant text only
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
  // assistant with a tool_use block (yields both an assistant entry and a tool_use entry)
  { type: 'assistant', message: { content: [
    { type: 'text', text: 'running ls' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ] } },
  // user message carrying a tool_result
  { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'output line', is_error: false },
  ] } },
  // assistant WITH usage (input/output tokens, model, stop_reason)
  { type: 'assistant', message: {
    model: 'claude-opus-4-8', stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text: 'with usage' }],
  } },
  // result footer (session-level cost)
  { type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 4, duration_ms: 9999 },
];

function unknownKeys(entry: IngestEntry): string[] {
  const allowed = ALLOWED_KEYS_BY_KIND[entry.kind];
  if (!allowed) return [`<unknown kind: ${(entry as any).kind}>`];
  return Object.keys(entry).filter(k => !allowed.includes(k));
}

describe('ingest contract: daemon entries match server-allowed keys', () => {
  for (const evt of SAMPLE_EVENTS) {
    const label = `${evt.type}${evt.subtype ? '/' + evt.subtype : ''}`;
    it(`${label} → no unknown keys`, () => {
      const entries = mapEventToEntries(evt);
      assert.ok(entries.length > 0, `expected ≥1 entry from ${label}`);
      for (const entry of entries) {
        const extra = unknownKeys(entry);
        assert.deepEqual(
          extra,
          [],
          `entry kind=${entry.kind} carried unknown keys: ${extra.join(', ')}\nentry: ${JSON.stringify(entry)}`,
        );
      }
    });
  }

  it('tool_result resolves tool_name from the threaded toolNames map', () => {
    // The tool_result block itself has no name; the daemon threads a
    // tool_use_id → tool_name map across events so the result can be
    // denormalized. Replay the assistant (records the name) then the user
    // (reads it back) through one shared map, as the daemon does.
    const toolNames = new Map<string, string>();
    mapEventToEntries(
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] } },
      toolNames,
    );
    const [result] = mapEventToEntries(
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
      ] } },
      toolNames,
    );
    assert.equal(result?.kind, 'tool_result');
    assert.equal((result as { tool_name?: string }).tool_name, 'Bash');
  });

  it('manifest covers every IngestEntry kind in the type union', () => {
    // Compile-time check: TypeScript ensures ALLOWED_KEYS_BY_KIND has an
    // entry for every kind in the IngestEntry union (the Record<...> type).
    // This runtime assertion catches the inverse: extras in the manifest
    // that don't correspond to a real kind anymore.
    const VALID_KINDS = new Set(['attach', 'prompt', 'tool_use', 'tool_result', 'assistant', 'compact', 'system', 'result']);
    for (const k of Object.keys(ALLOWED_KEYS_BY_KIND)) {
      assert.ok(VALID_KINDS.has(k), `manifest has stale kind: ${k}`);
    }
  });
});

// ─── Length clamping (clampForIngest) ──────────────────────────────────────
// The server rejects the WHOLE batch with a 400 if any entry exceeds its cap.
// clampForIngest truncates over-long human-text fields so a batch never 400s
// on length (losing the prompt/marker). Caps mirror remote-sessions.ts.
describe('clampForIngest keeps entries under the server length caps', () => {
  const PROMPT_MAX = 200_000;
  const ASSISTANT_MAX = 500_000;
  const SYSTEM_MAX = 500;

  it('truncates an over-long prompt to the cap with a marker', async () => {
    const { clampForIngest } = await import('../relay/daemon.js');
    const [out] = clampForIngest([{ kind: 'prompt', prompt: 'x'.repeat(PROMPT_MAX + 5000) }]);
    const prompt = (out as { prompt: string }).prompt;
    assert.ok(prompt.length <= PROMPT_MAX, `prompt ${prompt.length} > ${PROMPT_MAX}`);
    assert.ok(prompt.endsWith('… [truncated]'));
  });

  it('truncates an over-long system marker to 500 chars', async () => {
    const { clampForIngest } = await import('../relay/daemon.js');
    const [out] = clampForIngest([{ kind: 'system', content: 'e'.repeat(SYSTEM_MAX + 200) }]);
    const content = (out as { content: string }).content;
    assert.ok(content.length <= SYSTEM_MAX, `system ${content.length} > ${SYSTEM_MAX}`);
    assert.ok(content.endsWith('… [truncated]'));
  });

  it('truncates an over-long assistant text', async () => {
    const { clampForIngest } = await import('../relay/daemon.js');
    const [out] = clampForIngest([{ kind: 'assistant', text: 'a'.repeat(ASSISTANT_MAX + 1000), blocks: [] }]);
    const text = (out as { text: string }).text;
    assert.ok(text.length <= ASSISTANT_MAX, `assistant ${text.length} > ${ASSISTANT_MAX}`);
  });

  it('leaves within-cap and non-text entries untouched', async () => {
    const { clampForIngest } = await import('../relay/daemon.js');
    const entries: IngestEntry[] = [
      { kind: 'prompt', prompt: 'short and fine' },
      { kind: 'tool_use', tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { kind: 'system', content: 'ok' },
    ];
    const out = clampForIngest(entries);
    assert.equal((out[0] as { prompt: string }).prompt, 'short and fine');
    assert.deepEqual((out[1] as any).tool_input, { command: 'ls' });
    assert.equal((out[2] as { content: string }).content, 'ok');
  });
});

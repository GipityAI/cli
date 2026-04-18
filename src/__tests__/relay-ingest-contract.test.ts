/**
 * Contract test: every key the daemon emits in an ingest entry must appear
 * in the manifest below — which mirrors the server's `entrySchema`
 * (platform/server/src/routes/remote-sessions.ts). If `mapEventToEntries`
 * ever stamps a key the server doesn't accept, this test fails loudly
 * BEFORE the daemon ships and starts 400ing in production.
 *
 * Why a manifest instead of importing the server's Zod schema directly:
 * the CLI is a standalone npm package with a strict `rootDir: src`
 * tsconfig — a cross-workspace import won't typecheck. The manifest is
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
const ALLOWED_KEYS_BY_KIND: Record<IngestEntry['kind'], readonly string[]> = {
  attach:      ['kind', 'session_id', 'cwd', 'source'],
  prompt:      ['kind', 'prompt'],
  tool_use:    ['kind', 'tool_use_id', 'tool_name', 'tool_input'],
  tool_result: ['kind', 'tool_use_id', 'content', 'is_error'],
  assistant:   ['kind', 'text', 'blocks'],
  compact:     ['kind', 'trigger'],
  system:      ['kind', 'content'],
};

/** Sample stream-json events covering every branch of mapEventToEntries.
 *  When mapEventToEntries grows a new branch, add a sample here. */
const SAMPLE_EVENTS: any[] = [
  // attach
  { type: 'system', subtype: 'init', session_id: 'sess-abc', cwd: '/tmp/demo' },
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

  it('manifest covers every IngestEntry kind in the type union', () => {
    // Compile-time check: TypeScript ensures ALLOWED_KEYS_BY_KIND has an
    // entry for every kind in the IngestEntry union (the Record<...> type).
    // This runtime assertion catches the inverse: extras in the manifest
    // that don't correspond to a real kind anymore.
    const VALID_KINDS = new Set(['attach', 'prompt', 'tool_use', 'tool_result', 'assistant', 'compact', 'system']);
    for (const k of Object.keys(ALLOWED_KEYS_BY_KIND)) {
      assert.ok(VALID_KINDS.has(k), `manifest has stale kind: ${k}`);
    }
  });
});

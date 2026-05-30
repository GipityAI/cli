/**
 * Claude Code JSONL transcript → ingest entries.
 *
 * Claude Code writes one JSON object per line to
 *   ~/.claude/projects/<flattened-cwd>/<session_id>.jsonl
 * during interactive sessions. The `transcript_path` field on every hook
 * input points at that file. Line shapes we care about:
 *
 *   { type: 'user',      message: { content: string | Array<block> }, uuid, isSidechain, … }
 *   { type: 'assistant', message: { content: Array<block>, stop_reason, model, usage }, uuid, isSidechain, … }
 *
 * The inner `message.content` block schema matches stream-json's
 * assistant/user events (text blocks, tool_use blocks, tool_result
 * blocks), so the block-walking logic mirrors
 * `cli/src/relay/stream-json.ts`. Only the outer envelope is new:
 *
 *   - `queue-operation`, `summary`, and `toolUseResult` wrapper-only
 *     lines carry no primary message content and are skipped.
 *   - `isSidechain: true` lines come from Task subagent transcripts;
 *     SubagentStop fires on those separately, so we skip them here to
 *     avoid double-counting.
 *
 * Every emitted ingest entry is tagged with `source_uuid = line.uuid`
 * so retried POSTs are deduplicated by the partial unique index on
 * messages(conversation_id, source_uuid).
 */

// Every entry can carry an optional `ts` - the transcript line's ISO
// timestamp. The server stores it in the untrusted `messages.event_at`
// column for per-message timing; `created_at` stays server-authoritative.
export type IngestEntry =
  | { kind: 'attach'; session_id: string; cwd?: string; source?: 'startup' | 'resume' | 'clear' | 'compact'; source_uuid?: string; ts?: string }
  | { kind: 'prompt'; prompt: string; source_uuid?: string; ts?: string }
  | { kind: 'assistant'; text: string; blocks: any[]; source_uuid?: string; ts?: string }
  | { kind: 'tool_use'; tool_use_id: string; tool_name: string; tool_input?: unknown; source_uuid?: string; ts?: string }
  | { kind: 'tool_result'; tool_use_id: string; tool_name?: string; content: unknown; is_error?: boolean; source_uuid?: string; ts?: string }
  | { kind: 'compact'; trigger?: string; source_uuid?: string; ts?: string }
  | { kind: 'system'; content: string; source_uuid?: string; ts?: string };

/** Extract joined `{type:'text', text}` blocks into a single string.
 *  The full blocks array is emitted separately so the client can render
 *  text + tool_use in the agent's original narrative order. */
function joinText(content: any[] | undefined): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Stamp a unique `source_uuid` on every entry parsed from one transcript line.
 *
 *  One transcript line yields many entries (an assistant line emits its text
 *  entry PLUS one tool_use entry per tool call). The server dedupes ingest on
 *  the partial unique index messages(conversation_id, source_uuid) with
 *  ON CONFLICT DO NOTHING. If all siblings shared the bare `line.uuid`, the
 *  first entry (the assistant text) would claim the row and every subsequent
 *  tool_use would be silently dropped - leaving the later tool_result to land
 *  as a name-less stub. That bug made 100% of terminal-session tool calls lose
 *  their tool_name.
 *
 *  The primary entry keeps the bare line uuid (so it still dedupes against rows
 *  written before this fix); each sibling gets a deterministic `#N` suffix.
 *  Determinism matters: a retried POST re-parses the same line in the same
 *  order, producing identical suffixes, so dedup still collapses retries. */
function stampEntries(entries: IngestEntry[], lineUuid: string, lineTs?: string): IngestEntry[] {
  return entries.map((e, i) => ({
    ...e,
    source_uuid: i === 0 ? lineUuid : `${lineUuid}#${i}`,
    ...(lineTs ? { ts: lineTs } : {}),
  }));
}

/** Map a single parsed transcript line to zero or more ingest entries.
 *
 *  `toolNames` (optional) is a per-transcript `tool_use_id → tool_name`
 *  map threaded across lines by `parseTranscript`: an assistant line
 *  records each tool call's name into it, and the later user line that
 *  carries the paired `tool_result` reads the name back out. This lets
 *  the server denormalize `tool_name` onto the tool row even when the
 *  result lands as a stub (the tool_use row missing/deduped). The
 *  `tool_result` block itself never carries the name. */
export function transcriptLineToEntries(line: any, toolNames?: Map<string, string>): IngestEntry[] {
  if (!line || typeof line !== 'object') return [];
  if (typeof line.type !== 'string') return [];
  if (typeof line.uuid !== 'string' || !line.uuid) return [];
  if (line.isSidechain === true) return [];
  if (line.type === 'queue-operation') return [];
  if (line.type === 'summary') return [];
  if (line.toolUseResult && !line.message) return [];

  const srcUuid: string = line.uuid;
  const lineTs: string | undefined = typeof line.timestamp === 'string' ? line.timestamp : undefined;
  const msg = line.message ?? {};

  if (line.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      if (!content) return [];
      return stampEntries([{ kind: 'prompt', prompt: content }], srcUuid, lineTs);
    }
    if (Array.isArray(content)) {
      const out: IngestEntry[] = [];
      for (const b of content) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          out.push({
            kind: 'tool_result',
            tool_use_id: b.tool_use_id,
            tool_name: toolNames?.get(b.tool_use_id),
            content: b.content ?? null,
            is_error: Boolean(b.is_error),
          });
        } else if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
          // A user message with raw text blocks (rare - first-turn preamble
          // is sometimes split this way). Treat like a prompt.
          out.push({ kind: 'prompt', prompt: b.text });
        }
      }
      return stampEntries(out, srcUuid, lineTs);
    }
    return [];
  }

  if (line.type === 'assistant') {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = joinText(content);
    const out: IngestEntry[] = [];
    if (text || content.length) {
      out.push({ kind: 'assistant', text, blocks: content });
    }
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        const toolName = typeof block.name === 'string' ? block.name : 'tool';
        toolNames?.set(block.id, toolName);
        out.push({
          kind: 'tool_use',
          tool_use_id: block.id,
          tool_name: toolName,
          tool_input: block.input ?? null,
        });
      }
    }
    return stampEntries(out, srcUuid, lineTs);
  }

  // Other envelope types (system notes, hook-emitted, …) - not captured.
  return [];
}

/** Parse the full JSONL transcript and emit every ingest entry that
 *  comes *after* the line whose `uuid === afterUuid`. Returns the
 *  entries in order plus the last processed uuid (to save as the new
 *  watermark).
 *
 *  If `afterUuid` isn't found in the transcript - e.g. because Claude
 *  Code's `/clear` or compaction rewrote the file - the caller falls
 *  back to processing from the top; the server's `source_uuid` unique
 *  index dedupes any lines we already forwarded. */
export function parseTranscript(
  content: string,
  afterUuid: string | null,
): { entries: IngestEntry[]; lastUuid: string | null; foundWatermark: boolean } {
  let seenWatermark = afterUuid === null;
  let lastUuid: string | null = afterUuid;
  const out: IngestEntry[] = [];
  // tool_use_id → tool_name, accumulated across lines so a later
  // tool_result can be denormalized with its tool's name. Built from the
  // whole file (including pre-watermark lines) so a result whose tool_use
  // was forwarded in an earlier sweep still resolves its name.
  const toolNames = new Map<string, string>();

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }

    // Record tool names from every assistant line we scan, even before the
    // watermark - the map is read-only side state, it doesn't emit entries.
    if (!seenWatermark) {
      if (Array.isArray(parsed?.message?.content)) {
        for (const block of parsed.message.content) {
          if (block?.type === 'tool_use' && typeof block.id === 'string') {
            toolNames.set(block.id, typeof block.name === 'string' ? block.name : 'tool');
          }
        }
      }
      if (parsed?.uuid === afterUuid) seenWatermark = true;
      continue;
    }

    const entries = transcriptLineToEntries(parsed, toolNames);
    if (entries.length) {
      for (const e of entries) out.push(e);
      lastUuid = parsed.uuid;
    } else if (typeof parsed?.uuid === 'string' && parsed.uuid) {
      // Even skipped lines advance the watermark so we don't re-scan them
      // on the next hook fire. The source_uuid index on the server guards
      // the ingested entries; this keeps hot-path scans O(new-lines).
      lastUuid = parsed.uuid;
    }
  }

  return {
    entries: out,
    lastUuid,
    foundWatermark: seenWatermark,
  };
}

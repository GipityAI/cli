/**
 * Parser + mapper for `claude -p --output-format stream-json --verbose`.
 *
 * The daemon spawns Claude with this flag set and pipes stdout through
 * `parseEvent` + `mapEventToEntries`. Each ingest entry produced here is
 * POSTed to `/remote-sessions/:convGuid/ingest` - the single source of
 * truth for the conversation. There is no hook, no transcript-file
 * reading, no shared offset file: the daemon owns the capture entirely.
 *
 * Stream-json is a public, documented protocol. The Claude Agent SDK
 * uses it internally. That's what makes dropping the hook model
 * acceptable as a design - we're not scraping an internal format.
 */

// ─── Ingest wire format (matches server's /ingest Zod schema) ──────────

// `ts` is an optional informational hint (the daemon stamps it at the
// moment it reads the event off the stream). The server stores it in the
// untrusted `messages.event_at` column for per-event timing; `created_at`
// stays server-authoritative (NOW()), so a hint can't backdate history.
// `source_uuid` is the server-side dedup key (partial unique index on
// (conversation_id, source_uuid)), which is what makes retrying a failed
// ingest POST safe: a replayed entry collapses instead of duplicating.
// Stream-path stamping rules: assistant → `${message.id}#${n}` (assistant
// events arrive PER CONTENT BLOCK, several sharing one message id, so a
// bare id would dedup-drop later blocks); tool_use → its tool_use_id;
// daemon-authored prompt/system/result entries → a random UUID minted at
// creation. tool_result needs none (it's an idempotent UPDATE by id).
export type IngestEntry =
  | { kind: 'attach'; session_id: string; cwd?: string; source?: 'startup' | 'resume' | 'clear' | 'compact'; model?: string; tools_count?: number; mcp_count?: number; api_key_source?: string; ts?: string; source_uuid?: string }
  | { kind: 'prompt'; prompt: string; ts?: string; source_uuid?: string }
  // `parent_tool_use_id`: set on subagent-internal rows (a Task/Agent
  // spawn). Claude Code emits the subagent's events on the parent stdout
  // tagged with the spawning tool_use id; the web CLI nests them under
  // that Task block. NULL/absent for top-level messages.
  | { kind: 'assistant'; text: string; blocks: any[]; input_tokens?: number; output_tokens?: number; model?: string; stop_reason?: string; ts?: string; source_uuid?: string; parent_tool_use_id?: string }
  | { kind: 'tool_use'; tool_use_id: string; tool_name: string; tool_input?: unknown; ts?: string; source_uuid?: string; parent_tool_use_id?: string }
  | { kind: 'tool_result'; tool_use_id: string; tool_name?: string; content: unknown; is_error?: boolean; ts?: string; source_uuid?: string; parent_tool_use_id?: string }
  | { kind: 'compact'; trigger?: string; ts?: string; source_uuid?: string }
  | { kind: 'system'; content: string; ts?: string; source_uuid?: string }
  // The stream's final `result` footer: a session-level total. Only the daemon
  // (stream) path sees this; the hook/transcript path never does (cost isn't in
  // the transcript). Carries cost so the server can record it on the conversation.
  // NOTE: a spawn with background subagents can emit SEVERAL result events
  // (the loop re-invokes when a task completes; cost on later ones is
  // cumulative) - the daemon buffers and posts only the last.
  | { kind: 'result'; total_cost_usd?: number; num_turns?: number; duration_ms?: number; ts?: string; source_uuid?: string };

// ─── Stream-json event shapes ──────────────────────────────────────────
// Only the fields we actually read are typed - everything else is passed
// through loosely. Claude Code's event schema is documented but may grow
// subtypes; we treat unknown events as no-ops rather than failing hard.

export interface StreamJsonSystemInit {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: any[];
  /** How Claude Code is authenticating: 'none' = OAuth/subscription login;
   *  an api-key source = pay-per-token API billing. Drives sub-vs-API cost
   *  labeling in the web CLI. */
  apiKeySource?: string;
}

export interface StreamJsonAssistant {
  type: 'assistant';
  message: {
    id?: string;
    role?: 'assistant';
    content?: any[];
    stop_reason?: string;
    model?: string;
    usage?: any;
  };
}

export interface StreamJsonUser {
  type: 'user';
  message: {
    role?: 'user';
    content?: any[];
  };
}

export interface StreamJsonResult {
  type: 'result';
  subtype?: 'success' | 'error' | 'cancelled' | string;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  result?: string;
  session_id?: string;
  num_turns?: number;
  is_error?: boolean;
}

export type StreamJsonEvent =
  | StreamJsonSystemInit
  | StreamJsonAssistant
  | StreamJsonUser
  | StreamJsonResult
  | { type: string; [k: string]: any };

// ─── Parser ────────────────────────────────────────────────────────────

/** Defensive cap on a single NDJSON line. Real stream-json events are
 *  well under this; anything larger is almost certainly junk piped into
 *  stdout (or a malformed line that would OOM JSON.parse). Dropping one
 *  bad line is always safer than crashing the daemon. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Parse one NDJSON line. Returns null for blank lines, malformed JSON,
 *  records without a `type` field (stream-json always sets it), or
 *  absurdly long lines. An optional `onWarn` callback receives a reason
 *  code + a short snippet so the caller can log the drop - this keeps
 *  stream-json.ts free of daemon-specific logging. */
export function parseEvent(
  line: string,
  onWarn?: (reason: 'too_long' | 'bad_json' | 'bad_shape', snippet: string) => void,
): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINE_BYTES) {
    onWarn?.('too_long', `(${trimmed.length} bytes; first 200: ${trimmed.slice(0, 200)})`);
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    onWarn?.('bad_json', trimmed.slice(0, 200));
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    onWarn?.('bad_shape', trimmed.slice(0, 200));
    return null;
  }
  return parsed as StreamJsonEvent;
}

// ─── Event → ingest mapping ────────────────────────────────────────────

/** Extract `{type:'text', text:'…'}` blocks into a single joined string.
 *  The full content_blocks array is passed through separately so the
 *  client can render tool_use blocks in narrative order alongside text. */
function joinAssistantText(content: any[] | undefined): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Map a single stream-json event to zero or more ingest entries. An
 *  assistant event may yield one `assistant` entry AND one `tool_use`
 *  entry per tool_use block within it (server persists each tool call
 *  as its own `role='tool'` row, then updates it when the matching
 *  `tool_result` arrives).
 *
 *  `toolNames` (optional) is a per-dispatch `tool_use_id → tool_name`
 *  map threaded across events by the daemon: assistant events record
 *  each tool call's name, the later user event with the paired
 *  `tool_result` reads it back so the server can denormalize `tool_name`
 *  onto the tool row even when the result lands as a stub. */
export interface MapContext {
  /** Per-dispatch tool_use_id → tool_name (see doc above). */
  toolNames?: Map<string, string>;
  /** Per-dispatch assistant-event counter per message id. Assistant events
   *  arrive per content block with the same message id; the sequence
   *  number disambiguates the dedup key (`msg_x#0`, `msg_x#1`, …). */
  msgSeq?: Map<string, number>;
  /** Called once per unrecognized event so the daemon can account for
   *  what a newer Claude Code emitted that we silently skip. */
  onUnmapped?: (type: string, subtype?: string) => void;
}

export function mapEventToEntries(evt: StreamJsonEvent, ctx?: MapContext | Map<string, string>): IngestEntry[] {
  // Back-compat: older call sites (and tests) pass the bare toolNames map.
  const c: MapContext = ctx instanceof Map ? { toolNames: ctx } : (ctx ?? {});
  const toolNames = c.toolNames;
  const out: IngestEntry[] = [];

  if (evt.type === 'system' && (evt as StreamJsonSystemInit).subtype === 'init') {
    const s = evt as StreamJsonSystemInit;
    if (s.session_id) {
      out.push({
        kind: 'attach',
        session_id: s.session_id,
        cwd: s.cwd,
        source: 'startup',
        model: typeof s.model === 'string' ? s.model : undefined,
        tools_count: Array.isArray(s.tools) ? s.tools.length : undefined,
        mcp_count: Array.isArray(s.mcp_servers) ? s.mcp_servers.length : undefined,
        api_key_source: typeof s.apiKeySource === 'string' ? s.apiKeySource : undefined,
      });
    }
    return out;
  }

  // Context compaction boundary - the server has a `compact` kind for this
  // (renders as a "context compacted" marker); nothing emitted it before.
  if (evt.type === 'system' && (evt as any).subtype === 'compact_boundary') {
    const trigger = (evt as any).compact_metadata?.trigger ?? (evt as any).trigger;
    out.push({ kind: 'compact', trigger: typeof trigger === 'string' ? trigger : undefined });
    return out;
  }

  // Subagent attribution: the envelope carries the spawning Task/Agent
  // tool_use id on every event from that subagent's turn.
  const parentToolUseId = typeof (evt as any).parent_tool_use_id === 'string'
    ? (evt as any).parent_tool_use_id : undefined;

  if (evt.type === 'assistant') {
    const msg = (evt as StreamJsonAssistant).message ?? {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = joinAssistantText(content);
    if (text || content.length) {
      const entry: IngestEntry = { kind: 'assistant', text, blocks: content, ...usageFields(msg), parent_tool_use_id: parentToolUseId };
      // source_uuid = `${msg.id}#${eventSeq}`. The client's stream-zone
      // finalize-swap matches this against its block key `${msg.id}:${block_index}`,
      // i.e. it relies on eventSeq === block_index. That holds because
      // Claude Code (with --include-partial-messages) emits exactly ONE
      // assistant event per content block, in index order (verified
      // against CLI v2.1.199 in the Phase 0 spike: a thinking block and a
      // text block arrived as two separate assistant events, seq 0 and 1,
      // matching block indices 0 and 1). If a future CLI ever packs two
      // blocks into one assistant event, seq lags index for later blocks
      // and those streamed blocks aren't removed until the ack wipes the
      // zone - a cosmetic, self-healing duplication, not data loss.
      if (typeof msg.id === 'string' && msg.id && c.msgSeq) {
        const n = c.msgSeq.get(msg.id) ?? 0;
        c.msgSeq.set(msg.id, n + 1);
        entry.source_uuid = `${msg.id}#${n}`;
      }
      out.push(entry);
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
          source_uuid: block.id,
          parent_tool_use_id: parentToolUseId,
        });
      }
    }
    return out;
  }

  if (evt.type === 'user') {
    const msg = (evt as StreamJsonUser).message ?? {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        out.push({
          kind: 'tool_result',
          tool_use_id: block.tool_use_id,
          tool_name: toolNames?.get(block.tool_use_id),
          content: block.content ?? null,
          is_error: Boolean(block.is_error),
          parent_tool_use_id: parentToolUseId,
        });
      }
    }
    return out;
  }

  // `result` is the final footer — a session-level total. Emit a `result`
  // ingest entry carrying the cost so the server can record it on the
  // conversation. (Per-turn tokens ride on the assistant entries above; cost is
  // only ever here, and only on the stream path.)
  if (evt.type === 'result') {
    const r = evt as StreamJsonResult;
    if (typeof r.total_cost_usd === 'number' || typeof r.num_turns === 'number' || typeof r.duration_ms === 'number') {
      out.push({
        kind: 'result',
        total_cost_usd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
        num_turns: typeof r.num_turns === 'number' ? r.num_turns : undefined,
        duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : undefined,
      });
    }
    return out;
  }

  // Deliberately unmapped chatter (hook lifecycle, per-chunk thinking
  // token counts, rate-limit notices, and stream_event token deltas -
  // the latter are handled by the separate stream-delta pipeline) -
  // skipped without accounting so a normal session doesn't log dozens of
  // "unmapped" entries. Everything else unknown IS accounted via
  // onUnmapped so a new Claude Code event type shows up in the daemon
  // log instead of vanishing silently.
  const subtype = (evt as any).subtype as string | undefined;
  const KNOWN_NOISE = new Set(['hook_started', 'hook_response', 'thinking_tokens', 'status', 'task_started', 'task_progress', 'task_updated', 'task_notification']);
  if (!(evt.type === 'system' && subtype && KNOWN_NOISE.has(subtype))
      && evt.type !== 'rate_limit_event' && evt.type !== 'stream_event') {
    c.onUnmapped?.(evt.type, subtype);
  }
  return out;
}

/** Pull token usage + model + stop_reason off an assistant stream `message`.
 *  Same shape as the transcript path's `usageFields` (kept in sync; the two
 *  capture modules don't share a module). Cost is NOT per-message. */
function usageFields(msg: any): { input_tokens?: number; output_tokens?: number; model?: string; stop_reason?: string } {
  const out: { input_tokens?: number; output_tokens?: number; model?: string; stop_reason?: string } = {};
  const u = msg?.usage;
  if (u && typeof u.input_tokens === 'number') out.input_tokens = u.input_tokens;
  if (u && typeof u.output_tokens === 'number') out.output_tokens = u.output_tokens;
  if (typeof msg?.model === 'string') out.model = msg.model;
  if (typeof msg?.stop_reason === 'string') out.stop_reason = msg.stop_reason;
  return out;
}

// ─── Line-buffered stream splitter ─────────────────────────────────────

/** Safety cap on the accumulator when no newline has arrived yet. The
 *  per-line cap in `parseEvent` is 2 MB, but that only applies after we
 *  see a newline. A pathological producer that writes 100 MB of data
 *  without a `\n` would otherwise grow the buffer unboundedly. When we
 *  hit this cap we force-drain the buffer as one oversized "line" -
 *  `parseEvent` will drop it via its own length check and log a warning
 *  so the source is visible. */
const MAX_SPLITTER_BUF_BYTES = 4 * 1024 * 1024;

/** Build a splitter that accepts stdout chunks (strings or Buffers) and
 *  invokes `onLine` with each complete newline-delimited line. Keeps a
 *  partial trailing chunk in memory until the next newline arrives (or
 *  the safety cap fires), so a JSON event split across two reads still
 *  parses correctly. Call `flush()` at EOF to process any final
 *  unterminated line. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string | Buffer): void;
  flush(): void;
} {
  let buf = '';
  return {
    push(chunk: string | Buffer) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length) onLine(line);
      }
      // Force-drain the accumulator if it grows past the safety cap
      // without producing a newline. `onLine` handles the oversized
      // line (parseEvent's length guard will drop it with a warn).
      if (buf.length > MAX_SPLITTER_BUF_BYTES) {
        const over = buf;
        buf = '';
        onLine(over);
      }
    },
    flush() {
      if (buf.length) {
        onLine(buf);
        buf = '';
      }
    },
  };
}

/**
 * Parser + mapper for `claude -p --output-format stream-json --verbose`.
 *
 * The daemon spawns Claude with this flag set and pipes stdout through
 * `parseEvent` + `mapEventToEntries`. Each ingest entry produced here is
 * POSTed to `/remote-sessions/:convGuid/ingest` — the single source of
 * truth for the conversation. There is no hook, no transcript-file
 * reading, no shared offset file: the daemon owns the capture entirely.
 *
 * Stream-json is a public, documented protocol. The Claude Agent SDK
 * uses it internally. That's what makes dropping the hook model
 * acceptable as a design — we're not scraping an internal format.
 */

// ─── Ingest wire format (matches server's /ingest Zod schema) ──────────

// Note: no `ts` field. The server uses `messages.created_at = NOW()` as
// the authoritative timestamp; a client-supplied hint isn't read and is
// now rejected by the strict ingest schema.
export type IngestEntry =
  | { kind: 'attach'; session_id: string; cwd?: string; source?: 'startup' | 'resume' | 'clear' | 'compact' }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'assistant'; text: string; blocks: any[] }
  | { kind: 'tool_use'; tool_use_id: string; tool_name: string; tool_input?: unknown }
  | { kind: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { kind: 'compact'; trigger?: string }
  | { kind: 'system'; content: string };

// ─── Stream-json event shapes ──────────────────────────────────────────
// Only the fields we actually read are typed — everything else is passed
// through loosely. Claude Code's event schema is documented but may grow
// subtypes; we treat unknown events as no-ops rather than failing hard.

export interface StreamJsonSystemInit {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
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
 *  code + a short snippet so the caller can log the drop — this keeps
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
 *  `tool_result` arrives). */
export function mapEventToEntries(evt: StreamJsonEvent): IngestEntry[] {
  const out: IngestEntry[] = [];

  if (evt.type === 'system' && (evt as StreamJsonSystemInit).subtype === 'init') {
    const s = evt as StreamJsonSystemInit;
    if (s.session_id) out.push({ kind: 'attach', session_id: s.session_id, cwd: s.cwd, source: 'startup' });
    return out;
  }

  if (evt.type === 'assistant') {
    const msg = (evt as StreamJsonAssistant).message ?? {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = joinAssistantText(content);
    if (text || content.length) {
      out.push({ kind: 'assistant', text, blocks: content });
    }
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        out.push({
          kind: 'tool_use',
          tool_use_id: block.id,
          tool_name: typeof block.name === 'string' ? block.name : 'tool',
          tool_input: block.input ?? null,
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
          content: block.content ?? null,
          is_error: Boolean(block.is_error),
        });
      }
    }
    return out;
  }

  // `result` is the final footer. The daemon emits its own cosmetic
  // "Claude Code finished (Xs)" system marker anyway, so this event is
  // a no-op in the ingest stream. Kept here as a hook-point in case we
  // want to surface cost/usage later.
  return out;
}

// ─── Line-buffered stream splitter ─────────────────────────────────────

/** Safety cap on the accumulator when no newline has arrived yet. The
 *  per-line cap in `parseEvent` is 2 MB, but that only applies after we
 *  see a newline. A pathological producer that writes 100 MB of data
 *  without a `\n` would otherwise grow the buffer unboundedly. When we
 *  hit this cap we force-drain the buffer as one oversized "line" —
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

/**
 * Token-streaming delta pipeline for the relay daemon.
 *
 * With `--include-partial-messages`, Claude Code emits `stream_event`
 * envelopes (content_block_start / content_block_delta / content_block_stop)
 * carrying text, thinking, and tool-input fragments as they generate. The
 * daemon forwards them - throttled and redacted - to
 * `POST /remote-sessions/:convGuid/stream-delta`, which the server
 * broadcasts to the web CLI as `dispatch:delta`. Purely ephemeral: no DB
 * write, no retry; the persisted assistant/tool entries (whole events)
 * remain the source of truth and replace the streamed view on the next
 * refresh.
 *
 * Redaction across chunk boundaries: a secret split over two fragments
 * would defeat a per-fragment scrub. The accumulator therefore only ever
 * emits up to the last WHITESPACE boundary (holding back the trailing
 * partial token until more input or block close) and scrubs each emitted
 * span. Secrets in our threat set (host OAuth/API/device tokens, JWTs,
 * provider keys) are contiguous non-whitespace tokens, so a held-back
 * partial token can never leak a complete secret and a completed token is
 * always scrubbed whole. Multi-line PEM blocks are the one shape this
 * can't fully hold back - accepted on this ephemeral channel (the
 * persisted path fully redacts, and the streamed text is replaced by the
 * redacted stored message within seconds).
 */
import { redactString } from './redact.js';

export type DeltaBlockType = 'text' | 'thinking' | 'tool_use';
export type DeltaKind = 'start' | 'delta' | 'stop';

export interface StreamDeltaEvent {
  message_id: string;
  block_index: number;
  block_type: DeltaBlockType;
  kind: DeltaKind;
  /** Redacted fragment (kind='delta'). For tool_use blocks this is the
   *  partial JSON of the input being composed. */
  text?: string;
  /** Cumulative emitted (redacted) length before this fragment - lets the
   *  client detect a dropped flush and mark the gap instead of gluing
   *  mismatched fragments together. */
  acc_offset?: number;
  /** Tool name (block_type='tool_use', kind='start'). */
  tool_name?: string;
}

/** A trailing token longer than this is emitted anyway (minified code,
 *  base64 blobs) - holding back indefinitely would stall the stream. No
 *  credential in our threat set is this long. */
const MAX_HOLDBACK = 4096;

/** PEM key markers. A private key block spans multiple whitespace-
 *  separated lines, so the whitespace-boundary holdback would emit
 *  `BEGIN` before `END` arrives and per-span redaction would miss it.
 *  emitUpTo holds the whole block back until END so it scrubs whole. */
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Emit boundary: everything up to (and including) the last whitespace.
 *  `closing` (block stop) emits everything. */
export function safeEmitBoundary(s: string, closing: boolean): number {
  if (closing) return s.length;
  const m = s.match(/\S+$/);
  if (!m) return s.length;
  if (m[0].length > MAX_HOLDBACK) return s.length;
  return s.length - m[0].length;
}

interface BlockState {
  type: DeltaBlockType;
  raw: string;
  /** Chars of `raw` already consumed by emits (always at a whitespace
   *  boundary, so per-span scrubbing can't split a token). */
  rawEmitted: number;
  /** Cumulative redacted chars emitted (the client-facing offset space). */
  outEmitted: number;
  started: boolean;
}

/**
 * Per-spawn accumulator: feed it raw stream_event envelopes, it returns
 * redaction-safe StreamDeltaEvents ready to batch. Skips subagent events
 * (parent_tool_use_id set) - those belong to the nested Task timeline,
 * not the main stream zone.
 */
export class DeltaAccumulator {
  private blocks = new Map<string, BlockState>();
  /** The in-flight message's id, captured from `message_start` -
   *  content_block_* events don't carry it themselves. This is what makes
   *  the client-side finalize swap line up: persisted assistant rows are
   *  keyed `msg_id#n` (Phase 2 source_uuid), streamed blocks `msg_id:n`. */
  private currentMessageId = 'msg';

  constructor(private readonly getSecrets: () => string[]) {}

  /** Map one parsed stream-json event to zero or more delta events. */
  note(evt: { type: string; [k: string]: any }): StreamDeltaEvent[] {
    if (evt.type !== 'stream_event') return [];
    if (evt.parent_tool_use_id) return []; // subagent stream - not ours (Phase 6)
    const inner = evt.event;
    if (!inner || typeof inner.type !== 'string') return [];

    if (inner.type === 'message_start') {
      if (typeof inner.message?.id === 'string' && inner.message.id) {
        this.currentMessageId = inner.message.id;
      }
      return [];
    }
    const messageId = this.currentMessageId;

    if (inner.type === 'content_block_start') {
      const idx = typeof inner.index === 'number' ? inner.index : 0;
      const cb = inner.content_block ?? {};
      const type: DeltaBlockType | null =
        cb.type === 'text' ? 'text' : cb.type === 'thinking' ? 'thinking' : cb.type === 'tool_use' ? 'tool_use' : null;
      if (!type) return [];
      this.blocks.set(`${messageId}:${idx}`, { type, raw: '', rawEmitted: 0, outEmitted: 0, started: true });
      const out: StreamDeltaEvent = { message_id: messageId, block_index: idx, block_type: type, kind: 'start' };
      if (type === 'tool_use' && typeof cb.name === 'string') out.tool_name = cb.name;
      return [out];
    }

    if (inner.type === 'content_block_delta') {
      const idx = typeof inner.index === 'number' ? inner.index : 0;
      const d = inner.delta ?? {};
      const fragment: string | null =
        typeof d.text === 'string' ? d.text
        : typeof d.thinking === 'string' ? d.thinking
        : typeof d.partial_json === 'string' ? d.partial_json
        : null;
      if (fragment === null || fragment === '') return [];
      const key = `${messageId}:${idx}`;
      let b = this.blocks.get(key);
      if (!b) {
        // Delta without a start (daemon restarted mid-message or an
        // unknown block type at start time) - infer the type.
        const type: DeltaBlockType = typeof d.partial_json === 'string' ? 'tool_use'
          : typeof d.thinking === 'string' ? 'thinking' : 'text';
        b = { type, raw: '', rawEmitted: 0, outEmitted: 0, started: false };
        this.blocks.set(key, b);
      }
      b.raw += fragment;
      return this.emitUpTo(messageId, idx, b, false);
    }

    if (inner.type === 'content_block_stop') {
      const idx = typeof inner.index === 'number' ? inner.index : 0;
      const key = `${messageId}:${idx}`;
      const b = this.blocks.get(key);
      if (!b) return [];
      const out = this.emitUpTo(messageId, idx, b, true);
      out.push({ message_id: messageId, block_index: idx, block_type: b.type, kind: 'stop' });
      this.blocks.delete(key);
      return out;
    }

    return [];
  }

  private emitUpTo(messageId: string, idx: number, b: BlockState, closing: boolean): StreamDeltaEvent[] {
    // Scan only the not-yet-emitted tail: the boundary can never precede
    // rawEmitted (already a whitespace boundary), and running the regex
    // over the full accumulated `raw` on every fragment is O(n²) over a
    // long block - a big minified/base64 tool-input block would stall the
    // daemon's event loop (which also drives the ingest queue + ticks).
    const tail = b.raw.slice(b.rawEmitted);
    // PEM keys are the one multi-LINE secret the whitespace-boundary
    // holdback doesn't catch: `-----BEGIN … PRIVATE KEY-----` and its
    // `-----END-----` land in different spans, so per-span redactString
    // never sees them together. When an unterminated BEGIN marker is in
    // the pending tail, hold the WHOLE tail back until END arrives (or the
    // block closes), so redactString scrubs the complete block in one span.
    if (!closing && PEM_BEGIN.test(tail) && !PEM_END.test(tail)) return [];
    const tailBoundary = safeEmitBoundary(tail, closing);
    if (tailBoundary <= 0) return [];
    const span = tail.slice(0, tailBoundary);
    const boundary = b.rawEmitted + tailBoundary;
    b.rawEmitted = boundary;
    const scrubbed = redactString(span, this.getSecrets());
    if (!scrubbed) return [];
    const evt: StreamDeltaEvent = {
      message_id: messageId,
      block_index: idx,
      block_type: b.type,
      kind: 'delta',
      text: scrubbed,
      acc_offset: b.outEmitted,
    };
    b.outEmitted += scrubbed.length;
    return [evt];
  }
}

// ─── Throttled batcher ──────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 150;
const FLUSH_BYTES = 4096;
/** Server-side caps (mirror the /stream-delta Zod schema). */
const MAX_EVENTS_PER_FLUSH = 64;
const MAX_TEXT_PER_FLUSH = 16_384;

export interface DeltaFlush {
  seq: number;
  events: StreamDeltaEvent[];
}

/**
 * Buffers delta events and flushes them as numbered batches every 150ms
 * or 4KB, whichever first. Fire-and-forget by design: a lost flush
 * self-heals (the client detects the `acc_offset` gap and the next
 * refresh replaces the stream zone with the stored message anyway).
 */
export class DeltaBatcher {
  private buffer: StreamDeltaEvent[] = [];
  private bufferedText = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly send: (flush: DeltaFlush) => void,
    private readonly intervalMs = FLUSH_INTERVAL_MS,
  ) {}

  push(events: StreamDeltaEvent[]): void {
    if (this.closed || events.length === 0) return;
    for (const e of events) {
      this.buffer.push(e);
      this.bufferedText += e.text?.length ?? 0;
    }
    if (this.bufferedText >= FLUSH_BYTES || this.buffer.length >= MAX_EVENTS_PER_FLUSH) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.buffer.length) {
      // Respect both server caps per POST: event count and total text.
      const batch: StreamDeltaEvent[] = [];
      let text = 0;
      while (this.buffer.length && batch.length < MAX_EVENTS_PER_FLUSH) {
        const next = this.buffer[0];
        const nextLen = next.text?.length ?? 0;
        if (batch.length > 0 && text + nextLen > MAX_TEXT_PER_FLUSH) break;
        // A single oversized event gets truncated rather than wedging the queue.
        if (nextLen > MAX_TEXT_PER_FLUSH) next.text = next.text!.slice(0, MAX_TEXT_PER_FLUSH);
        batch.push(this.buffer.shift()!);
        text += next.text?.length ?? 0;
      }
      this.bufferedText = Math.max(0, this.bufferedText - text);
      this.send({ seq: this.seq++, events: batch });
    }
    this.bufferedText = 0;
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}

/**
 * opencode transcript JSONL → ingest entries.
 *
 * opencode does not write a single transcript file itself - it persists
 * sessions as per-message JSON blobs in its own storage dir. The Gipity
 * opencode plugin (installed to ~/.config/opencode/plugins/gipity.js by
 * `gipity` setup, shipped in the GipityAI/skills repo) bridges that gap: on
 * every `session.idle` it fetches the full message list over the opencode
 * server SDK and rewrites
 *   ~/.gipity/opencode/transcripts/<session_id>.jsonl
 * with one line per message, then invokes the capture runner (`capture.cjs
 * opencode stop`). Line shape (SDK types, opencode 1.18.x):
 *
 *   { info: UserMessage | AssistantMessage, parts: Part[] }
 *
 *   info.role 'user'      → prompt entry (joined text parts; synthetic parts
 *                           are plugin/system injections and are skipped)
 *   info.role 'assistant' → assistant entry (text, tokens, modelID, finish)
 *                           + tool_use per tool part (stable `callID`)
 *                           + tool_result per completed/errored tool part
 *   reasoning / step-start / step-finish / file / snapshot parts → SKIP
 *
 * Dedup/watermark: message ids (`msg_…`) are stable and ordered, so the
 * watermark is the last message id emitted. The file is fully rewritten each
 * idle; a watermark that no longer appears (deleted/forked session) makes the
 * caller replay from the top, and the server's source_uuid unique index
 * collapses anything already forwarded. tool_use/tool_result key off the
 * stable `callID`, which survives rewrites.
 */

import type { IngestEntry } from './claude-code.js';

function toIso(ms: unknown): string | undefined {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function joinTextParts(parts: any[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string' && !p.synthetic && !p.ignored) {
      out.push(p.text);
    }
  }
  return out.join('\n');
}

function messageToEntries(info: any, parts: any[]): IngestEntry[] {
  if (!info || typeof info.id !== 'string') return [];
  const ts = toIso(info?.time?.created);

  if (info.role === 'user') {
    const prompt = joinTextParts(parts);
    if (!prompt) return [];
    return [{ kind: 'prompt', prompt, source_uuid: info.id, ...(ts ? { ts } : {}) }];
  }

  if (info.role === 'assistant') {
    const out: IngestEntry[] = [];
    const text = joinTextParts(parts);
    const toolParts = parts.filter((p) => p?.type === 'tool' && typeof p.callID === 'string' && p.callID);
    if (text || toolParts.length) {
      out.push({
        kind: 'assistant',
        text,
        blocks: text ? [{ type: 'text', text }] : [],
        ...(typeof info?.tokens?.input === 'number' ? { input_tokens: info.tokens.input } : {}),
        ...(typeof info?.tokens?.output === 'number' ? { output_tokens: info.tokens.output } : {}),
        ...(typeof info.modelID === 'string' ? { model: info.modelID } : {}),
        ...(typeof info.finish === 'string' ? { stop_reason: info.finish } : {}),
        source_uuid: info.id,
        ...(ts ? { ts } : {}),
      });
    }
    for (const p of toolParts) {
      const toolName = typeof p.tool === 'string' && p.tool ? p.tool : 'tool';
      out.push({
        kind: 'tool_use',
        tool_use_id: p.callID,
        tool_name: toolName,
        tool_input: p?.state?.input ?? null,
        source_uuid: p.callID,
      });
      const status = p?.state?.status;
      if (status === 'completed' || status === 'error') {
        out.push({
          kind: 'tool_result',
          tool_use_id: p.callID,
          tool_name: toolName,
          content: status === 'error' ? (p.state.error ?? '') : (p.state.output ?? ''),
          ...(status === 'error' ? { is_error: true } : {}),
          source_uuid: `${p.callID}#out`,
        });
      }
    }
    return out;
  }

  return [];
}

/** Parse the plugin-written transcript JSONL and emit every ingest entry that
 *  comes *after* the message-id watermark `afterUuid`. Same contract as the
 *  claude-code parser. */
export function parseTranscript(
  content: string,
  afterUuid: string | null,
): { entries: IngestEntry[]; lastUuid: string | null; foundWatermark: boolean; usage: { tokensIn: number; tokensOut: number } } {
  const lines = content.split('\n');

  // First pass: locate the watermark message so a rewind/fork (id gone)
  // replays from the top instead of wedging capture.
  let watermarkLine = -1;
  if (afterUuid) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        if (JSON.parse(line)?.info?.id === afterUuid) { watermarkLine = i; break; }
      } catch { /* skip unparseable */ }
    }
  }
  const foundWatermark = afterUuid === null || watermarkLine !== -1;

  const out: IngestEntry[] = [];
  let lastUuid: string | null = foundWatermark ? afterUuid : null;
  // Token totals for the newly parsed range. tokens_in is the full input side
  // (fresh input + cache read/write) to match the relay result footer's
  // semantics; the per-entry input_tokens stays `tokens.input` only.
  let tokensIn = 0;
  let tokensOut = 0;
  const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

  for (let i = 0; i < lines.length; i++) {
    if (watermarkLine !== -1 && i <= watermarkLine) continue;
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    const info = parsed?.info;
    const entries = messageToEntries(info, Array.isArray(parsed?.parts) ? parsed.parts : []);
    if (!entries.length) continue;
    // Count usage only for lines that emit entries: entry-less lines don't
    // advance the watermark, so counting them would re-add their tokens on
    // every subsequent flush.
    if (info?.role === 'assistant' && info?.tokens) {
      tokensIn += num(info.tokens.input) + num(info.tokens.cache?.read) + num(info.tokens.cache?.write);
      tokensOut += num(info.tokens.output);
    }
    for (const e of entries) out.push(e);
    if (typeof info?.id === 'string') lastUuid = info.id;
  }

  return { entries: out, lastUuid, foundWatermark, usage: { tokensIn, tokensOut } };
}

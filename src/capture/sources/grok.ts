/**
 * Grok Build chat_history.jsonl transcript → ingest entries.
 *
 * Grok Build persists each session under
 *   ~/.grok/sessions/<urlencoded-cwd>/<session_id>/
 * with several files; `chat_history.jsonl` is the clean one-message-per-line
 * conversation log and our parse target (events.jsonl is lifecycle noise,
 * updates.jsonl is a chunked ACP stream). Verified against real sessions
 * (Grok Build / grok-4.5, 2026-07-13). Line shapes:
 *
 *   { type: 'system',      content }                          → SKIP (system prompt)
 *   { type: 'user',        content, synthetic_reason?, prompt_index? }
 *       synthetic_reason present → SKIP (injected context, not the user)
 *       else → prompt entry
 *   { type: 'assistant',   content, tool_calls?: [{id,name,arguments}],
 *                          model_id?, reasoning_effort? }     → assistant (+ tool_use per call)
 *   { type: 'tool_result', tool_call_id, content }            → tool_result
 *   { type: 'reasoning',   encrypted_content, summary }       → SKIP (parity with Claude parser)
 *
 * Grok hook payloads may not carry a transcript path; the capture runner
 * derives it from the hook's cwd + session_id
 * (`~/.grok/sessions/<encodeURIComponent(cwd)>/<session_id>/chat_history.jsonl`).
 *
 * Dedup/watermark: chat_history lines carry no uuid or timestamp, so uuids
 * are synthesized. tool_use/tool_result key off the stable `tool_calls[].id`
 * (`call-<uuid>-N`), which survives file rewrites; assistant/prompt entries
 * use positional `<session_id>#<lineIndex>` uuids. The watermark is
 * positional; a foreign watermark (session id mismatch / rotated file) makes
 * the caller replay from the top, and the server's source_uuid unique index
 * collapses anything already forwarded.
 */

import type { IngestEntry } from './claude-code.js';

export interface ParseContext {
  /** The agent session id, from the hook payload. Keys the positional uuids;
   *  without it dedup still works via the stable tool-call ids. */
  sessionId?: string;
}

function positional(sessionId: string, idx: number): string {
  return `${sessionId}#${idx}`;
}

function watermarkIndex(afterUuid: string | null, sessionId: string): number | null {
  if (!afterUuid || !sessionId) return null;
  const prefix = `${sessionId}#`;
  if (!afterUuid.startsWith(prefix)) return null;
  const idx = parseInt(afterUuid.slice(prefix.length), 10);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Defensive: some harness versions may block-structure content.
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof (b as any).text === 'string') parts.push((b as any).text);
    }
    return parts.join('\n');
  }
  return '';
}

function lineToEntries(
  parsed: any,
  sessionId: string,
  idx: number,
  toolNames: Map<string, string>,
): IngestEntry[] {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return [];

  if (parsed.type === 'user') {
    if (parsed.synthetic_reason) return []; // injected context, not the user
    let prompt = contentToText(parsed.content);
    if (!prompt) return [];
    // Grok also injects an environment block as a PLAIN user line (no
    // synthetic_reason) at session start - recognizable by its wrapper tag.
    if (prompt.startsWith('<user_info>')) return [];
    // The real prompt arrives wrapped in <user_query> tags - unwrap for
    // clean display; the wrapper is Grok plumbing, not what the user typed.
    const m = prompt.match(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/);
    if (m) prompt = m[1];
    if (!prompt) return [];
    return [{ kind: 'prompt', prompt, source_uuid: positional(sessionId, idx) }];
  }

  if (parsed.type === 'assistant') {
    const text = contentToText(parsed.content);
    const out: IngestEntry[] = [];
    const calls: any[] = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    if (text || calls.length) {
      out.push({
        kind: 'assistant',
        text,
        blocks: text ? [{ type: 'text', text }] : [],
        ...(typeof parsed.model_id === 'string' ? { model: parsed.model_id } : {}),
        source_uuid: positional(sessionId, idx),
      });
    }
    for (const call of calls) {
      if (!call || typeof call.id !== 'string' || !call.id) continue;
      const toolName = typeof call.name === 'string' && call.name ? call.name : 'tool';
      toolNames.set(call.id, toolName);
      let toolInput: unknown = call.arguments ?? null;
      if (typeof toolInput === 'string') {
        try { toolInput = JSON.parse(toolInput); } catch { /* keep raw string */ }
      }
      out.push({
        kind: 'tool_use',
        tool_use_id: call.id,
        tool_name: toolName,
        tool_input: toolInput,
        source_uuid: call.id,
      });
    }
    return out;
  }

  if (parsed.type === 'tool_result') {
    if (typeof parsed.tool_call_id !== 'string' || !parsed.tool_call_id) return [];
    return [{
      kind: 'tool_result',
      tool_use_id: parsed.tool_call_id,
      tool_name: toolNames.get(parsed.tool_call_id),
      content: parsed.content ?? null,
      source_uuid: `${parsed.tool_call_id}#out`,
    }];
  }

  return []; // system, reasoning, unknown
}

/** Parse the full chat_history JSONL and emit every ingest entry that comes
 *  *after* the positional watermark `afterUuid`. Same contract as the
 *  claude-code parser. */
export function parseTranscript(
  content: string,
  afterUuid: string | null,
  ctx: ParseContext = {},
): { entries: IngestEntry[]; lastUuid: string | null; foundWatermark: boolean } {
  const sessionId = ctx.sessionId ?? '';
  const lines = content.split('\n');

  // A watermark pointing past EOF means the file shrank under the same
  // session id (e.g. a rewind rewrote chat_history). Treat it as not-found
  // so the caller replays from the top - otherwise capture wedges silently.
  let startAfter = watermarkIndex(afterUuid, sessionId);
  if (startAfter !== null && startAfter >= lines.length) startAfter = null;
  const foundWatermark = afterUuid === null || startAfter !== null;

  const out: IngestEntry[] = [];
  const toolNames = new Map<string, string>();
  let lastIdx: number | null = startAfter;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }

    if (startAfter !== null && i <= startAfter) {
      // Pre-watermark: record tool names only, so a post-watermark
      // tool_result still resolves the name of an already-forwarded call.
      if (parsed?.type === 'assistant' && Array.isArray(parsed.tool_calls)) {
        for (const call of parsed.tool_calls) {
          if (call && typeof call.id === 'string' && call.id) {
            toolNames.set(call.id, typeof call.name === 'string' && call.name ? call.name : 'tool');
          }
        }
      }
      continue;
    }

    const entries = lineToEntries(parsed, sessionId, i, toolNames);
    for (const e of entries) out.push(e);
    lastIdx = i;
  }

  return {
    entries: out,
    lastUuid: lastIdx === null ? afterUuid : positional(sessionId, lastIdx),
    foundWatermark,
  };
}

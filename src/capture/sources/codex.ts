/**
 * Codex rollout JSONL transcript → ingest entries.
 *
 * Codex writes one JSON object per line to
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl
 * and every hook payload carries `transcript_path` pointing at that file.
 *
 * IMPORTANT: the rollout format is NOT the `codex exec --json` stream schema
 * (no `thread.started` / `item.*` events). Verified against real files
 * (Codex CLI v0.144.1, 2026-07-13); each line is an envelope:
 *
 *   { timestamp: ISO, type: <envelope>, payload: {...} }
 *
 * Envelope types and how we map them:
 *   - session_meta   → carries payload.session_id + cwd; read the session id,
 *                      emit nothing (the runner's SessionStart handler posts
 *                      the attach entry).
 *   - response_item  → the conversation itself (OpenAI Responses API items):
 *       payload.type 'message', role 'assistant' → assistant entry (has a
 *         stable `id` (msg_…) and a `phase`: 'commentary' | 'final_answer' -
 *         both are real assistant output, keep both).
 *       payload.type 'message', role 'user' | 'developer' → SKIP. Codex
 *         injects instructions and environment context as user/developer
 *         messages; the clean prompt arrives as an event_msg user_message.
 *       payload.type 'custom_tool_call' | 'function_call' → tool_use entry,
 *         keyed by the stable `call_id`.
 *       payload.type 'custom_tool_call_output' | 'function_call_output' →
 *         tool_result entry paired by `call_id`.
 *       payload.type 'reasoning' → SKIP (parity with the Claude parser).
 *   - event_msg      → lifecycle/dup stream:
 *       payload.type 'user_message' → prompt entry (the clean user text).
 *       payload.type 'error' → system entry.
 *       everything else ('agent_message' duplicates the assistant
 *       response_item, 'token_count', 'task_started', 'task_complete') → SKIP.
 *   - turn_context / world_state → SKIP.
 *
 * Dedup/watermark: rollout lines carry no per-line uuid, so we synthesize.
 * Entries prefer STABLE payload ids (assistant `msg_…` id, tool `call_id`) so
 * a resumed session whose new rollout file replays history still dedupes
 * across files; id-less entries (prompts) fall back to a positional
 * `<session_id>#<lineIndex>` uuid. The WATERMARK is always positional
 * (`<session_id>#<lineIndex>`): if the file rotated or the session id
 * changed, the caller replays from the top and the server's source_uuid
 * unique index collapses anything already forwarded.
 */

import type { IngestEntry } from './claude-code.js';

/** Join Responses-API content blocks ({type:'output_text'|'input_text'|'text', text}) */
function joinBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof (b as any).text === 'string') parts.push((b as any).text);
  }
  return parts.join('\n');
}

function positional(sessionId: string, idx: number): string {
  return `${sessionId}#${idx}`;
}

/** Parse `afterUuid` back into a line index IF it belongs to this session's
 *  positional scheme. Returns null for foreign/absent watermarks. */
function watermarkIndex(afterUuid: string | null, sessionId: string): number | null {
  if (!afterUuid || !sessionId) return null;
  const prefix = `${sessionId}#`;
  if (!afterUuid.startsWith(prefix)) return null;
  const idx = parseInt(afterUuid.slice(prefix.length), 10);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

function lineToEntries(
  parsed: any,
  sessionId: string,
  idx: number,
  toolNames: Map<string, string>,
): IngestEntry[] {
  const ts: string | undefined = typeof parsed?.timestamp === 'string' ? parsed.timestamp : undefined;
  const payload = parsed?.payload;
  if (!payload || typeof payload !== 'object') return [];

  if (parsed.type === 'response_item') {
    const ptype = payload.type;
    if (ptype === 'message' && payload.role === 'assistant') {
      const text = joinBlocks(payload.content);
      const blocks = [{ type: 'text', text }];
      return [{
        kind: 'assistant',
        text,
        blocks,
        source_uuid: typeof payload.id === 'string' && payload.id ? payload.id : positional(sessionId, idx),
        ...(ts ? { ts } : {}),
      }];
    }
    if (ptype === 'custom_tool_call' || ptype === 'function_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : positional(sessionId, idx);
      const toolName = typeof payload.name === 'string' && payload.name ? payload.name : 'tool';
      toolNames.set(callId, toolName);
      // custom_tool_call carries `input` (string); function_call carries
      // `arguments` (JSON string). Surface parsed JSON when it parses.
      let toolInput: unknown = payload.input ?? payload.arguments ?? null;
      if (typeof toolInput === 'string') {
        try { toolInput = JSON.parse(toolInput); } catch { /* keep raw string */ }
      }
      return [{
        kind: 'tool_use',
        tool_use_id: callId,
        tool_name: toolName,
        tool_input: toolInput,
        source_uuid: callId,
        ...(ts ? { ts } : {}),
      }];
    }
    if (ptype === 'custom_tool_call_output' || ptype === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : positional(sessionId, idx);
      return [{
        kind: 'tool_result',
        tool_use_id: callId,
        tool_name: toolNames.get(callId),
        content: joinBlocks(payload.output) || (typeof payload.output === 'string' ? payload.output : null),
        source_uuid: `${callId}#out`,
        ...(ts ? { ts } : {}),
      }];
    }
    return []; // user/developer messages, reasoning, anything unknown
  }

  if (parsed.type === 'event_msg') {
    if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message) {
      return [{
        kind: 'prompt',
        prompt: payload.message,
        source_uuid: positional(sessionId, idx),
        ...(ts ? { ts } : {}),
      }];
    }
    if (payload.type === 'error') {
      const msg = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
      return [{
        kind: 'system',
        content: `Codex error: ${msg}`,
        source_uuid: positional(sessionId, idx),
        ...(ts ? { ts } : {}),
      }];
    }
    return [];
  }

  return []; // session_meta, turn_context, world_state, unknown envelopes
}

/** Parse the full rollout JSONL and emit every ingest entry that comes
 *  *after* the positional watermark `afterUuid`. Same contract as the
 *  claude-code parser: returns entries in order, the new watermark, and
 *  whether the old watermark was still valid for this file. */
export function parseTranscript(
  content: string,
  afterUuid: string | null,
): { entries: IngestEntry[]; lastUuid: string | null; foundWatermark: boolean } {
  const lines = content.split('\n');

  // The session id lives in the first session_meta line. Without it we can
  // still parse - positional uuids just key off an empty session id, and the
  // stable payload ids carry dedup.
  let sessionId = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'session_meta' && typeof parsed.payload?.session_id === 'string') {
        sessionId = parsed.payload.session_id;
      }
    } catch { /* not JSON - keep looking */ }
    break; // only the first non-empty line can be session_meta
  }

  // A watermark pointing past EOF means the file was replaced by a SHORTER
  // one under the same session id (a resume writes a fresh rollout; the old
  // state file still carries the old file's position). Treat it as not-found
  // so the caller replays from the top - otherwise every line of the new
  // file sits "before" the watermark and capture wedges silently forever.
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
      const p = parsed?.payload;
      if (parsed?.type === 'response_item' && p &&
          (p.type === 'custom_tool_call' || p.type === 'function_call') &&
          typeof p.call_id === 'string') {
        toolNames.set(p.call_id, typeof p.name === 'string' && p.name ? p.name : 'tool');
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

/**
 * Antigravity (`agy`) transcript JSONL → ingest entries.
 *
 * agy writes one JSON object per line to
 *   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
 * and every hook payload carries `transcriptPath` pointing at that exact
 * file - no derivation needed (unlike Grok, which has to build the path from
 * cwd + session id).
 *
 * Verified against a real transcript (agy v1.1.2, 2026-07-22). Each line:
 *   { step_index, source, type, status, created_at, content?, thinking? }
 *
 * `step_index` is unique per line but NOT reliably monotonic with file order
 * (two adjacent lines in a real transcript had swapped step_index values) -
 * so watermarking uses the positional `<conversationId>#<lineIndex>` scheme,
 * same as the Codex parser, never `step_index` itself.
 *
 * Entry types and how we map them:
 *   - USER_INPUT (source USER_EXPLICIT) → prompt entry. The real user text is
 *     wrapped as `<USER_REQUEST>...</USER_REQUEST>`, followed by injected
 *     `<ADDITIONAL_METADATA>`/`<USER_SETTINGS_CHANGE>` blocks - extract just
 *     the USER_REQUEST body.
 *   - PLANNER_RESPONSE (source MODEL) → assistant entry, but ONLY when
 *     `content` is present and non-empty. A response that immediately calls a
 *     tool carries `thinking` with no `content` at all (confirmed live) -
 *     that's an internal-only step, not a user-visible reply, so it's SKIPPED
 *     rather than surfaced as an empty assistant message.
 *   - CODE_ACTION (source MODEL) → system entry. Its `content` is already a
 *     human-readable narrative of the action taken ("Created file...", "The
 *     following changes were made by replace_file_content..."), not a
 *     structured tool call - there is no separate tool_name/tool_input to
 *     recover from this JSON, so it doesn't fit the tool_use/tool_result
 *     shape the way Claude's/Codex's own tool-call envelopes do.
 *   - CONVERSATION_HISTORY, EPHEMERAL_MESSAGE, CHECKPOINT, SYSTEM_MESSAGE, and
 *     anything unrecognized → SKIP. These are internal bookkeeping/reminders
 *     the model sees but a human observer shouldn't - same philosophy as the
 *     other parsers dropping their own housekeeping envelopes.
 */
import type { IngestEntry } from './claude-code.js';

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

function extractUserRequest(content: string): string {
  const m = USER_REQUEST_RE.exec(content);
  return m ? m[1].trim() : content.trim();
}

function positional(conversationId: string, idx: number): string {
  return `${conversationId}#${idx}`;
}

function watermarkIndex(afterUuid: string | null, conversationId: string): number | null {
  if (!afterUuid || !conversationId) return null;
  const prefix = `${conversationId}#`;
  if (!afterUuid.startsWith(prefix)) return null;
  const idx = parseInt(afterUuid.slice(prefix.length), 10);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

function lineToEntries(parsed: any, conversationId: string, idx: number): IngestEntry[] {
  const ts: string | undefined = typeof parsed?.created_at === 'string' ? parsed.created_at : undefined;
  const type = parsed?.type;
  const content = parsed?.content;
  const uuid = positional(conversationId, idx);

  if (type === 'USER_INPUT' && typeof content === 'string' && content) {
    const prompt = extractUserRequest(content);
    if (!prompt) return [];
    return [{ kind: 'prompt', prompt, source_uuid: uuid, ...(ts ? { ts } : {}) }];
  }

  if (type === 'PLANNER_RESPONSE') {
    if (typeof content !== 'string' || !content) return []; // thinking-only turn, nothing user-visible
    return [{
      kind: 'assistant',
      text: content,
      blocks: [{ type: 'text', text: content }],
      source_uuid: uuid,
      ...(ts ? { ts } : {}),
    }];
  }

  if (type === 'CODE_ACTION') {
    if (typeof content !== 'string' || !content) return [];
    return [{ kind: 'system', content, source_uuid: uuid, ...(ts ? { ts } : {}) }];
  }

  return []; // CONVERSATION_HISTORY, EPHEMERAL_MESSAGE, CHECKPOINT, SYSTEM_MESSAGE, unknown
}

/** Same contract as the other source parsers: entries after `afterUuid`, the
 *  new watermark, and whether the old watermark was still valid for this
 *  file. `conversationId` comes from the hook payload (capture-runner passes
 *  it as `hook.session_id`), not from the file content - agy's transcript
 *  lines carry no conversation/session id field of their own. */
export function parseTranscript(
  content: string,
  afterUuid: string | null,
  opts: { conversationId?: string } = {},
): { entries: IngestEntry[]; lastUuid: string | null; foundWatermark: boolean } {
  const conversationId = opts.conversationId ?? '';
  const lines = content.split('\n');

  // A watermark past EOF means the file was replaced by a shorter one under
  // the same conversation id (mirrors the Codex parser's resume-rotation
  // guard) - treat as not-found so the caller replays from the top instead of
  // wedging forever.
  let startAfter = watermarkIndex(afterUuid, conversationId);
  if (startAfter !== null && startAfter >= lines.length) startAfter = null;
  const foundWatermark = afterUuid === null || startAfter !== null;

  const out: IngestEntry[] = [];
  let lastIdx: number | null = startAfter;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (startAfter !== null && i <= startAfter) continue;

    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }

    for (const e of lineToEntries(parsed, conversationId, i)) out.push(e);
    lastIdx = i;
  }

  return {
    entries: out,
    lastUuid: lastIdx === null ? afterUuid : positional(conversationId, lastIdx),
    foundWatermark,
  };
}

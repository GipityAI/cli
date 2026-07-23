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
 *   - PLANNER_RESPONSE (source MODEL) → a `tool_use` entry per item in its
 *     `tool_calls` array (confirmed live: `{name, args}`, e.g.
 *     `{"name":"run_command","args":{"CommandLine":"echo x", ...}}` - args
 *     becomes `tool_input` verbatim), PLUS an `assistant` entry when `content`
 *     is present and non-empty. A response that immediately calls a tool
 *     carries `thinking`/`tool_calls` with no `content` at all (confirmed
 *     live) - that's fine, it just means no assistant entry for that line.
 *   - Tool-result narratives → `tool_result` entries pairing back to the
 *     tool_use ids from the immediately preceding tool_calls-bearing line.
 *     agy has NO single generic "tool result" type - it's per tool category
 *     (confirmed live: `CODE_ACTION` for file-write tools, `RUN_COMMAND` for
 *     the shell tool; presumably others for browser/search/etc. tools not yet
 *     seen). So rather than an exhaustive allowlist, any type NOT in the known
 *     bookkeeping set below, carrying a non-empty `content` string, is treated
 *     as a result narrative. No pending tool_use to pair with (shouldn't
 *     normally happen, but the format doesn't guarantee it) falls back to a
 *     plain `system` entry so the content isn't silently dropped.
 *   - CONVERSATION_HISTORY, EPHEMERAL_MESSAGE, CHECKPOINT, SYSTEM_MESSAGE →
 *     SKIP. These are internal bookkeeping/reminders the model sees but a
 *     human observer shouldn't - same philosophy as the other parsers
 *     dropping their own housekeeping envelopes. Anything else unrecognized
 *     (no `content`, not one of the above) is also skipped.
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

/** Internal bookkeeping/reminder line types - never surfaced, and never treated
 *  as a tool-result narrative either (see the module docstring). */
const SKIP_TYPES = new Set(['CONVERSATION_HISTORY', 'EPHEMERAL_MESSAGE', 'CHECKPOINT', 'SYSTEM_MESSAGE']);

function watermarkIndex(afterUuid: string | null, conversationId: string): number | null {
  if (!afterUuid || !conversationId) return null;
  const prefix = `${conversationId}#`;
  if (!afterUuid.startsWith(prefix)) return null;
  const idx = parseInt(afterUuid.slice(prefix.length), 10);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/** Pending tool_use ids from the most recent tool_calls-bearing line, carried
 *  into the next line so a following CODE_ACTION can pair its result back to
 *  them - agy's transcript has no other linking key between a tool call and
 *  its human-readable result narrative. `toolName` is kept only for the
 *  common single-call case, to label the tool_result. */
interface PendingToolUse { ids: string[]; toolName?: string }

/** Per-line result: the entries this line produces, the tool_use ids it
 *  minted (empty once consumed/not applicable), and whether this line should
 *  update `pending` at all - a SKIP_TYPES line (housekeeping the model sees
 *  but that carries no tool information) must leave a still-unresolved
 *  tool_use's `pending` state untouched rather than clearing it, since one of
 *  these can legitimately appear between a tool call and its result line
 *  (confirmed live). */
function lineToEntries(
  parsed: any, conversationId: string, idx: number, pending: PendingToolUse | null,
): { entries: IngestEntry[]; pendingToolUseIds: PendingToolUse | null; clearsPending: boolean } {
  const ts: string | undefined = typeof parsed?.created_at === 'string' ? parsed.created_at : undefined;
  const type = parsed?.type;
  const content = parsed?.content;
  const uuid = positional(conversationId, idx);
  // A content-less/unrecognized line carries no information either way, so it
  // must not disturb a still-unresolved tool_use (clearsPending: false) - same
  // reasoning as the SKIP_TYPES branch below.
  const none = { entries: [] as IngestEntry[], pendingToolUseIds: pending, clearsPending: false };

  if (type === 'USER_INPUT' && typeof content === 'string' && content) {
    const prompt = extractUserRequest(content);
    if (!prompt) return none;
    return {
      entries: [{ kind: 'prompt', prompt, source_uuid: uuid, ...(ts ? { ts } : {}) }],
      pendingToolUseIds: null, clearsPending: true,
    };
  }

  if (type === 'PLANNER_RESPONSE') {
    const entries: IngestEntry[] = [];
    const ids: string[] = [];
    let toolName: string | undefined;
    const toolCalls = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [];
    toolCalls.forEach((call: any, i: number) => {
      if (!call || typeof call.name !== 'string') return;
      const toolUseId = toolCalls.length > 1 ? `${uuid}:${i}` : uuid;
      ids.push(toolUseId);
      toolName = call.name;
      entries.push({
        kind: 'tool_use',
        tool_use_id: toolUseId,
        tool_name: call.name,
        tool_input: call.args,
        source_uuid: toolUseId,
        ...(ts ? { ts } : {}),
      });
    });
    if (typeof content === 'string' && content) {
      entries.push({
        kind: 'assistant',
        text: content,
        blocks: [{ type: 'text', text: content }],
        source_uuid: uuid,
        ...(ts ? { ts } : {}),
      });
    }
    return { entries, pendingToolUseIds: ids.length ? { ids, toolName } : null, clearsPending: true };
  }

  // Bookkeeping the model sees but a human observer shouldn't - and, per the
  // interface doc above, must NOT clear a still-unresolved tool_use either.
  if (SKIP_TYPES.has(type)) return { entries: [], pendingToolUseIds: pending, clearsPending: false };

  // Anything else with real prose content is a tool-result-shaped narrative
  // (CODE_ACTION, RUN_COMMAND, or an as-yet-unseen TOOL_CATEGORY name) - see
  // the module docstring for why this isn't an exhaustive type allowlist.
  if (typeof content === 'string' && content) {
    if (pending) {
      return {
        entries: pending.ids.map((toolUseId, i) => ({
          kind: 'tool_result',
          tool_use_id: toolUseId,
          tool_name: pending.toolName,
          content,
          source_uuid: i === 0 ? uuid : `${uuid}:${i}`,
          ...(ts ? { ts } : {}),
        } as IngestEntry)),
        pendingToolUseIds: null, clearsPending: true,
      };
    }
    // No preceding tool_calls to pair with (shouldn't normally happen) -
    // don't drop the content, just fall back to a plain system note.
    return {
      entries: [{ kind: 'system', content, source_uuid: uuid, ...(ts ? { ts } : {}) }],
      pendingToolUseIds: null, clearsPending: true,
    };
  }

  return none; // no content, nothing worth surfacing (also clears pending)
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
  let pending: PendingToolUse | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (startAfter !== null && i <= startAfter) continue;

    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }

    const result = lineToEntries(parsed, conversationId, i, pending);
    for (const e of result.entries) out.push(e);
    if (result.clearsPending) pending = result.pendingToolUseIds;
    lastIdx = i;
  }

  return {
    entries: out,
    lastUuid: lastIdx === null ? afterUuid : positional(conversationId, lastIdx),
    foundWatermark,
  };
}

#!/usr/bin/env node
/**
 * Internal hook runner - invoked by the coding agent's lifecycle hooks
 * (SessionStart, Stop, SubagentStop, SessionEnd, and a throttled
 * PostToolUse for mid-run flushing) to mirror a terminal agent session
 * into the Gipity server so the web CLI can display it read-only.
 *
 * Works for every supported agent: Claude Code and Grok Build fire it
 * through the Gipity plugin's hooks (Grok runs Claude-format plugin hooks
 * natively; capture.cjs rewrites the source to 'grok' when it sees
 * GROK_HOOK_EVENT), Codex through the project's .codex/hooks.json. Each
 * source has its own transcript parser under cli/src/capture/sources/.
 *
 * Not a user-facing `gipity` subcommand by design: users never invoke
 * this directly. The hook scripts (skills repo hooks/scripts/capture.cjs)
 * resolve this file inside the installed CLI at fire time and run it - so
 * the capture logic versions with the CLI, not the plugin.
 *
 * Usage:
 *   node capture-runner.js <source> <event>
 *   source: 'claude-code' | 'codex' | 'grok'
 *   event:  'session-start' | 'stop' | 'subagent-stop' | 'session-end' | 'post-tool-use' | 'pre-compact'
 *
 * Conversation binding, in order:
 *   1. GIPITY_CONVERSATION_GUID env var - set by `gipity build`, which
 *      created/reused the conversation before spawning the agent.
 *   2. A session_id → conv mapping persisted in the capture-state dir by
 *      an earlier event of this session.
 *   3. Self-arm: the session was launched WITHOUT `gipity build` (bare
 *      `claude` / `codex` / `grok` in a linked project dir). Resolve the
 *      project from .gipity.json and ask the server to bind this
 *      session_id to a conversation (POST /remote-sessions/resolve), then
 *      persist the mapping. This is what makes bare agent sessions record.
 *
 * Graceful no-ops (exit 0 silently):
 *   - GIPITY_CAPTURE=off - the relay daemon owns capture for this run
 *     (it parses stream-json from stdout), or the caller opted out.
 *   - No binding resolvable: not a Gipity project, `captureHooks: false`
 *     in .gipity.json, or the resolve call failed.
 *   - The machine isn't paired - no device token available.
 *   - Anything unexpected (parse error, network error, etc.). We must
 *     not break the user's interactive session.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  utimesSync,
  createReadStream,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDevice } from '../relay/state.js';
import { deviceFetch } from '../relay/device-http.js';
import { ImageBlockRewriter } from '../relay/media-upload.js';
import { getConfig } from '../config.js';
import type { IngestEntry } from '../capture/sources/claude-code.js';
import { AGENT_ADAPTERS } from '../agents/index.js';
import type { CaptureHookInput, CaptureParseResult, RemoteAgentAdapter } from '../agents/index.js';

const CAPTURE_DIR = join(homedir(), '.gipity', 'capture-state');
const INGEST_BATCH_MAX = 100; // server caps at 200; stay comfortably under

type HookInput = CaptureHookInput;
type ParseResult = CaptureParseResult;

/** Find the agent adapter whose capture wiring owns this hook-argv source
 *  spelling (what the hook scripts pass - NOT the server's `source` value;
 *  those differ for Claude: 'claude-code' vs 'claude_code'). Adding an agent
 *  = one file under cli/src/agents/ with a `capture` field; no separate
 *  registry to keep in sync. */
function findCaptureAdapter(hookKey: string): RemoteAgentAdapter | undefined {
  return AGENT_ADAPTERS.find((a) => a.capture.hookKey === hookKey);
}

interface StateFile {
  last_uuid: string | null;
  // Wall-clock of the last successful flush. Used to throttle the
  // high-frequency PostToolUse trigger (see POST_TOOL_FLUSH_MS).
  last_flush_ms?: number;
  // Whether the 'attach' entry (binds remote_session_id server-side, which
  // is what makes resume work) has been sent for this session. Sent once,
  // from whichever event fires first - agy has no SessionStart-equivalent
  // event, so it can't rely on a specific event name the way Claude/Codex
  // do (see ensureAttached).
  attached?: boolean;
  // Metrics accumulated across flushes but not yet rolled into the
  // conversation via a `result` entry. Mid-run flushes (PostToolUse,
  // pre-compact, subagent-stop) advance the watermark, so the Stop-time
  // flush alone can't see the whole prompt run - these carry the earlier
  // flushes' share until Stop/SessionEnd emits the result and resets them.
  pending_tokens_in?: number;
  pending_tokens_out?: number;
  pending_active_ms?: number;
}

// PostToolUse fires after every tool call. We flush on it so a session that is
// killed/crashes mid-run (e.g. a long headless `gipity claude -p` build that
// hits a timeout) still has its transcript in the DB - Stop/SessionEnd only
// fire on a CLEAN exit, so without this an interrupted run loses EVERYTHING.
// Throttled to one flush per this interval to bound the cost of re-scanning a
// growing transcript on every tool call; a kill then loses at most this much tail.
const POST_TOOL_FLUSH_MS = 10_000;

function statePath(convGuid: string): string {
  return join(CAPTURE_DIR, `${convGuid}.json`);
}

function lockPath(convGuid: string): string {
  return join(CAPTURE_DIR, `${convGuid}.lock`);
}

function readState(convGuid: string): StateFile | null {
  const p = statePath(convGuid);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    const posNum = (v: unknown): number | undefined => (typeof v === 'number' && v >= 0 ? v : undefined);
    return {
      last_uuid: typeof parsed.last_uuid === 'string' ? parsed.last_uuid : null,
      last_flush_ms: typeof parsed.last_flush_ms === 'number' ? parsed.last_flush_ms : undefined,
      attached: typeof parsed.attached === 'boolean' ? parsed.attached : undefined,
      pending_tokens_in: posNum(parsed.pending_tokens_in),
      pending_tokens_out: posNum(parsed.pending_tokens_out),
      pending_active_ms: posNum(parsed.pending_active_ms),
    };
  } catch {
    return null;
  }
}

function writeState(convGuid: string, st: StateFile): void {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  writeFileSync(statePath(convGuid), JSON.stringify(st, null, 2) + '\n');
}

function deleteState(convGuid: string): void {
  try { unlinkSync(statePath(convGuid)); } catch { /* already gone */ }
  try { unlinkSync(lockPath(convGuid)); } catch { /* already gone */ }
}

// Crash-safe reclaim, mirroring the advisory lock in src/sync.ts: a holder
// writes its PID and heartbeats the lock's mtime; a peer reclaims it when the
// holder crashed (dead PID), died before writing a PID (empty/garbage file), or
// went silent past the stale window (wedged, or its PID was reused by an
// unrelated process). Without this a SIGKILL'd hook would strand the lock and
// silently disable capture for that conversation until SessionEnd.
const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_STALE_MS = 90_000;

/** Decide whether an existing capture lock is reclaimable. Exported for tests.
 *  Kept in sync with sync.ts's namesake. */
export function isLockReclaimable(path: string, now = Date.now()): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, 'utf-8').trim();
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false; // unreadable / already gone - don't steal, just skip
  }
  const pid = parseInt(raw, 10);
  if (!raw || !pid || isNaN(pid)) return true; // empty/garbage = crashed mid-create
  try { process.kill(pid, 0); }
  catch { return true; }                        // holder PID is dead
  return now - mtimeMs > LOCK_STALE_MS;          // alive but heartbeat went silent
}

/** Exclusive file-lock via `wx` open, with crash-safe reclaim. Stop and
 *  SubagentStop can fire concurrently on the same conv (e.g. a Task subagent
 *  finishing while the parent is also wrapping up), and a crashed hook retry
 *  would race the next one. Holding a lock for the duration serializes them.
 *  Returns a releaser, or null when a *live* holder is already flushing - in
 *  which case we skip this run; the holder will catch our data on its next
 *  transcript scan. A dead/abandoned holder's lock is reclaimed once and
 *  retried rather than waited on (capture is fire-and-forget; we never block
 *  the user's session). Exported for tests. */
export function acquireLock(convGuid: string): (() => void) | null {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const path = lockPath(convGuid);
  // At most one reclaim+retry: a genuinely live holder is flushing the same
  // transcript, so we just skip; only a crashed/stale holder is stolen.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');   // fails if the file exists
    } catch {
      if (attempt === 0 && isLockReclaimable(path)) {
        try { unlinkSync(path); } catch { /* race - someone else got it */ }
        continue;
      }
      return null; // live holder (or lost the reclaim race) - let it cover us
    }
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    // Heartbeat the mtime so a long flush isn't mistaken for abandoned. unref()
    // so the timer never keeps the hook process alive on its own.
    const beat = setInterval(() => {
      try { utimesSync(path, new Date(), new Date()); } catch { /* lock gone */ }
    }, LOCK_HEARTBEAT_MS);
    beat.unref?.();
    return () => {
      clearInterval(beat);
      try { unlinkSync(path); } catch { /* already gone */ }
    };
  }
  return null;
}

// ─── conversation binding ────────────────────────────────────────────
// Sessions launched via `gipity claude` carry GIPITY_CONVERSATION_GUID.
// Bare `claude` in a linked project has no env binding, so the first
// event resolves one from the server (keyed by the agent session_id) and
// persists it here for every later event of the session.

/** session_id is Claude Code's session UUID - filesystem-safe by
 *  construction; the character guard keeps a hostile hook payload from
 *  escaping the capture-state dir (used for both the mapping file and
 *  the resolve lock). */
function safeSessionKey(sessionId: string): string {
  return `sid-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function sessionMapPath(sessionId: string): string {
  return join(CAPTURE_DIR, `${safeSessionKey(sessionId)}.json`);
}

function readSessionMap(sessionId: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(sessionMapPath(sessionId), 'utf-8'));
    return typeof parsed.conv_guid === 'string' ? parsed.conv_guid : null;
  } catch {
    return null;
  }
}

function writeSessionMap(sessionId: string, convGuid: string): void {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  writeFileSync(sessionMapPath(sessionId), JSON.stringify({ conv_guid: convGuid }) + '\n');
}

function deleteSessionMap(sessionId: string): void {
  try { unlinkSync(sessionMapPath(sessionId)); } catch { /* already gone */ }
}

/** Ask the server which conversation this session belongs to: the conv
 *  already bound to this session_id (resume), the project's still-empty
 *  placeholder, or a fresh one. Returns null on any failure - capture is
 *  best-effort and must never break the session. */
async function resolveFromServer(projectGuid: string, hook: HookInput, serverSource: string): Promise<string | null> {
  let res: Response;
  try {
    res = await deviceFetch('POST', '/remote-sessions/resolve', {
      project_guid: projectGuid,
      session_id: hook.session_id,
      cwd: hook.cwd,
      source: serverSource,
    }, 15_000);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = await res.json() as { data?: { conversation_guid?: string } };
    return body.data?.conversation_guid ?? null;
  } catch {
    return null;
  }
}

/** Resolve the conversation this event writes to. Env binding first (set
 *  by `gipity claude`), then the session's persisted mapping, then the
 *  self-arm server resolve. The resolve is serialized per-session with
 *  the same crash-safe lock the flushers use, so concurrent hooks (Stop +
 *  SubagentStop) can't each mint a conversation: the loser polls for the
 *  winner's mapping instead of racing the server. */
export async function resolveConvGuid(
  hook: HookInput,
  serverSource = 'claude_code',
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
): Promise<string | null> {
  const fromEnv = process.env.GIPITY_CONVERSATION_GUID;
  if (fromEnv) return fromEnv;

  const sessionId = hook.session_id;
  if (!sessionId) return null;

  const mapped = readSessionMap(sessionId);
  if (mapped) return mapped;

  // Self-arm gates: linked project, capture not opted out, machine paired
  // (main() already checked the device, but resolveConvGuid is also the
  // unit-tested entry - keep it self-sufficient).
  const config = getConfig();
  if (!config?.projectGuid || config.captureHooks === false) return null;
  if (!getDevice()) return null;

  const release = acquireLock(safeSessionKey(sessionId));
  if (!release) {
    // Another hook instance is resolving this session right now. Give it
    // a moment and use its result; bail silently if it never lands (the
    // next event retries the whole resolution).
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const conv = readSessionMap(sessionId);
      if (conv) return conv;
    }
    return null;
  }
  try {
    // Re-check under the lock - the previous holder may have just finished.
    const raced = readSessionMap(sessionId);
    if (raced) return raced;
    const conv = await resolveFromServer(config.projectGuid, hook, serverSource);
    if (conv) writeSessionMap(sessionId, conv);
    return conv;
  } finally {
    release();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

async function postEntries(convGuid: string, entries: IngestEntry[]): Promise<boolean> {
  if (!entries.length) return true;
  // Batch into server-cap-safe chunks.
  for (let i = 0; i < entries.length; i += INGEST_BATCH_MAX) {
    const slice = entries.slice(i, i + INGEST_BATCH_MAX);
    let res: Response;
    try {
      res = await deviceFetch(
        'POST',
        `/remote-sessions/${encodeURIComponent(convGuid)}/ingest`,
        { entries: slice },
        15_000,
      );
    } catch {
      return false;
    }
    if (!res.ok) return false;
  }
  return true;
}

async function readWholeFile(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buf = '';
    const s = createReadStream(path, { encoding: 'utf-8' });
    s.on('data', (chunk: string | Buffer) => { buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8'); });
    s.on('end', () => resolve(buf));
    s.on('error', (err) => reject(err));
  });
}

/** Bind the session_id to this conversation server-side (remote_session_id -
 *  what makes resume work), once per conversation. Called for EVERY event,
 *  not just SessionStart: Claude/Codex fire a real SessionStart hook, but
 *  agy's event set has no equivalent (PreToolUse/PostToolUse/PreInvocation/
 *  PostInvocation/Stop only) - and the dispatch path (GIPITY_CONVERSATION_GUID
 *  env var) never touches resolveFromServer's own attach either, since it
 *  short-circuits before that call. Idempotent both here (the `attached`
 *  state flag) and server-side (attachRemoteSessionId only assigns when
 *  remote_session_id IS NULL), so calling it redundantly for agents that DO
 *  have a SessionStart event is harmless. */
async function ensureAttached(convGuid: string, hook: HookInput): Promise<void> {
  if (!hook.session_id) return;
  const state = readState(convGuid);
  if (state?.attached) return;

  const entries: IngestEntry[] = [{
    kind: 'attach',
    session_id: hook.session_id,
    cwd: hook.cwd,
    source: 'startup',
    source_uuid: `${hook.session_id}-attach`,
  }];
  const ok = await postEntries(convGuid, entries);
  if (ok) writeState(convGuid, { ...(state ?? { last_uuid: null }), attached: true });
}

// A gap between consecutive transcript timestamps longer than this is idle
// time (e.g. a replayed range spanning the user's think-time between
// prompts), not agent work - skip it when estimating active time.
export const ACTIVE_GAP_MAX_MS = 5 * 60_000;

/** Estimate the agent's working time over a batch of entries: the sum of
 *  gaps between consecutive entry timestamps, skipping idle stretches.
 *  Within one prompt run the transcript grows continuously (tool calls,
 *  assistant chunks), so this tracks real work closely; the hook path has no
 *  agent-reported duration the way the relay's stream `result` footer does. */
export function activeMsFromEntries(entries: IngestEntry[]): number {
  let total = 0;
  let prev: number | null = null;
  for (const e of entries) {
    if (!e.ts) continue;
    const t = Date.parse(e.ts);
    if (isNaN(t)) continue;
    if (prev !== null) {
      const gap = t - prev;
      if (gap > 0 && gap <= ACTIVE_GAP_MAX_MS) total += gap;
    }
    prev = t;
  }
  return total;
}

/** Fallback token totals for parsers that don't report `usage` (Codex, Grok):
 *  sum the assistant entries' token fields. Claude/opencode override this via
 *  ParseResult.usage - their per-entry fields undercount (no cache tokens)
 *  or repeat across lines, which a plain entry sum can't correct. */
export function entryTokenTotals(entries: IngestEntry[]): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const e of entries) {
    if (e.kind !== 'assistant') continue;
    if (typeof e.input_tokens === 'number' && e.input_tokens > 0) tokensIn += e.input_tokens;
    if (typeof e.output_tokens === 'number' && e.output_tokens > 0) tokensOut += e.output_tokens;
  }
  return { tokensIn, tokensOut };
}

async function handleStopFamily(
  convGuid: string, src: RemoteAgentAdapter, hook: HookInput, isSubagent: boolean, minIntervalMs = 0,
  emitResult = false,
): Promise<void> {
  void isSubagent;
  if (!hook.transcript_path || !existsSync(hook.transcript_path)) return;

  // Throttle high-frequency callers (PostToolUse). Stop/SessionEnd pass
  // minIntervalMs=0 so they always flush in full on a clean exit.
  if (minIntervalMs > 0) {
    const prev = readState(convGuid);
    if (prev?.last_flush_ms && Date.now() - prev.last_flush_ms < minIntervalMs) return;
  }

  const release = acquireLock(convGuid);
  if (!release) return; // another hook instance is already flushing; it'll catch our lines

  try {
    const state = readState(convGuid) ?? { last_uuid: null };
    const content = await readWholeFile(hook.transcript_path);

    let replayed = false;
    let result = src.capture.parse(content, state.last_uuid, hook);
    if (!result.foundWatermark && state.last_uuid !== null) {
      // Transcript rotated (/clear or compact) - watermark isn't present.
      // Replay from top; server dedupes via the source_uuid unique index.
      result = src.capture.parse(content, null, hook);
      replayed = true;
    }

    // Base64 image blocks (Read-of-image tool results) upload to VFS and
    // become image_ref blocks — same no-inline-base64 chokepoint as the
    // daemon's stream path. Content-hash storage keeps replays idempotent.
    const rewriter = new ImageBlockRewriter(convGuid);
    if (hook.cwd) rewriter.setCwd(hook.cwd);
    const entries = await rewriter.rewrite(result.entries);

    // Roll this flush's token usage + working time into the pending
    // counters. A replayed-from-top range re-parses lines whose rows the
    // server already has (and whose tokens an earlier result already
    // counted), so its usage is unknowable without server state - skip it
    // rather than double-count; only the rotation boundary is undercounted.
    const flushUsage = replayed
      ? { tokensIn: 0, tokensOut: 0 }
      : result.usage ?? entryTokenTotals(result.entries);
    const flushActive = replayed ? 0 : activeMsFromEntries(result.entries);
    const pendIn = (state.pending_tokens_in ?? 0) + flushUsage.tokensIn;
    const pendOut = (state.pending_tokens_out ?? 0) + flushUsage.tokensOut;
    const pendActive = (state.pending_active_ms ?? 0) + flushActive;

    // On a clean end-of-run event, emit the accumulated metrics as a
    // `result` entry - the same footer the relay's stream path posts, which
    // the server rolls into the conversation counters the projects list
    // reads (tokens_in/tokens_out/active_ms). The source_uuid is
    // deterministic in the watermark so a retried POST dedupes instead of
    // double-counting. No cost here: only the stream footer reports cost.
    let resultEmitted = false;
    if (emitResult && result.lastUuid && (pendIn > 0 || pendOut > 0 || pendActive > 0)) {
      const lastTs = [...entries].reverse().find((e) => e.ts)?.ts;
      entries.push({
        kind: 'result',
        tokens_in: pendIn,
        tokens_out: pendOut,
        duration_ms: pendActive,
        source_uuid: `${hook.session_id ?? convGuid}-result-${result.lastUuid}`,
        ...(lastTs ? { ts: lastTs } : {}),
      });
      resultEmitted = true;
    }

    const ok = await postEntries(convGuid, entries);
    if (ok) {
      // Stamp the flush time even when no new lines landed, so the throttle
      // above measures from the last attempt. Keep the watermark if unchanged.
      writeState(convGuid, {
        ...state,
        last_uuid: result.lastUuid ?? state.last_uuid,
        last_flush_ms: Date.now(),
        pending_tokens_in: resultEmitted ? 0 : pendIn,
        pending_tokens_out: resultEmitted ? 0 : pendOut,
        pending_active_ms: resultEmitted ? 0 : pendActive,
      });
    }
  } finally {
    release();
  }
}

async function handleSessionEnd(convGuid: string, src: RemoteAgentAdapter, hook: HookInput): Promise<void> {
  // Flush any tail lines one last time - SessionEnd fires after the final
  // Stop, so there's usually nothing new, but a race between Stop and
  // SessionEnd could leave lines behind.
  if (hook.transcript_path && existsSync(hook.transcript_path)) {
    await handleStopFamily(convGuid, src, hook, false, 0, true);
  }

  const sessionId = hook.session_id ?? 'unknown';
  const entries: IngestEntry[] = [{
    kind: 'system',
    content: `${src.displayName} finished`,
    source_uuid: `${sessionId}-end`,
  }];
  await postEntries(convGuid, entries);

  deleteState(convGuid);
  if (hook.session_id) deleteSessionMap(hook.session_id);
}

// Codex and agy have no SessionEnd-equivalent hook, so their capture-state/
// session-map files are never cleaned by handleSessionEnd. Sweep anything
// stale on the way through - the files are tiny, so a generous TTL is fine; a
// live session's state is
// rewritten on every flush and never gets this old.
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sweepStaleState(): void {
  let names: string[];
  try { names = readdirSync(CAPTURE_DIR); } catch { return; }
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const name of names) {
    const p = join(CAPTURE_DIR, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch { /* raced or unreadable - leave it */ }
  }
}

/** Normalize a raw hook payload to snake_case HookInput. Claude Code and
 *  Codex deliver snake_case (`session_id`, `transcript_path`, `cwd`); Grok
 *  Build delivers camelCase (`sessionId`, `hookEventName`, …); agy calls its
 *  session id `conversationId` (its own hook payload has no session/cwd/event
 *  fields under any other name - see cli/src/agents/agy.ts). Accept all of
 *  these so one runner serves every harness. */
export function normalizeHookInput(raw: any): HookInput {
  if (!raw || typeof raw !== 'object') return {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  const hook: HookInput = {
    session_id: pick('session_id', 'sessionId', 'conversationId'),
    transcript_path: pick('transcript_path', 'transcriptPath'),
    cwd: pick('cwd', 'workingDirectory'),
    hook_event_name: pick('hook_event_name', 'hookEventName'),
  };
  // Preserve extras the handlers peek at (e.g. pre-compact's `trigger`).
  if (typeof raw.trigger === 'string') (hook as any).trigger = raw.trigger;
  return hook;
}

async function main(): Promise<void> {
  // Explicit capture opt-out. Set by the relay daemon's dispatch spawns
  // (the daemon parses stream-json from stdout - hook capture would
  // double-post every event) and available to anyone wanting a one-off
  // unrecorded session.
  if (process.env.GIPITY_CAPTURE === 'off') return;
  if (!getDevice()) return; // machine not paired

  const [source, event] = process.argv.slice(2);
  if (!source || !event) return;
  const src = findCaptureAdapter(source);
  if (!src) return; // unknown agent - silent no-op

  const stdin = await readStdin();
  let hook: HookInput = {};
  if (stdin.trim()) {
    try { hook = normalizeHookInput(JSON.parse(stdin)); } catch { /* ignore - event may not require transcript */ }
  }

  // Agents whose hook payloads omit the transcript path (Grok) get it
  // derived from the session id + cwd.
  if (!hook.transcript_path && src.capture.resolveTranscriptPath) {
    const derived = src.capture.resolveTranscriptPath(hook);
    if (derived) hook.transcript_path = derived;
  }

  // Opportunistic hygiene: Codex and agy never fire session-end, so their
  // state files are TTL-swept instead of deleted at end-of-session.
  sweepStaleState();

  const convGuid = await resolveConvGuid(hook, src.source);
  if (!convGuid) return; // not a Gipity-bound session - nothing to capture

  await ensureAttached(convGuid, hook);

  try {
    switch (event) {
      case 'session-start':
        break; // ensureAttached above already covers what this event used to do
      case 'stop':
        // End of a prompt run - flush AND roll the run's accumulated
        // tokens/working time into the conversation via a result entry.
        await handleStopFamily(convGuid, src, hook, false, 0, true);
        break;
      case 'subagent-stop':
        await handleStopFamily(convGuid, src, hook, true);
        break;
      case 'post-tool-use':
        // Incremental mid-run flush so an interrupted session keeps its
        // transcript (Stop/SessionEnd only fire on clean exit). Throttled.
        await handleStopFamily(convGuid, src, hook, false, POST_TOOL_FLUSH_MS);
        break;
      case 'session-end':
        await handleSessionEnd(convGuid, src, hook);
        break;
      case 'pre-compact': {
        // Flush the transcript tail BEFORE compaction rewrites it (the
        // watermark replay after a rewrite relies on server dedup, but
        // flushing first keeps ordering clean), then record the boundary.
        await handleStopFamily(convGuid, src, hook, false);
        const trigger = typeof (hook as any).trigger === 'string' ? (hook as any).trigger : 'auto';
        await postEntries(convGuid, [{
          kind: 'compact',
          trigger,
          source_uuid: `${hook.session_id ?? 'unknown'}-compact-${Date.now()}`,
        }]);
        break;
      }
      default:
        return; // unknown event - silent no-op
    }
  } catch {
    // Never break the user's interactive session. All failures are silent.
  }
}

void main();

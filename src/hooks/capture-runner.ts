#!/usr/bin/env node
/**
 * Internal hook runner - invoked by Claude Code's lifecycle hooks
 * (SessionStart, Stop, SubagentStop, SessionEnd, and a throttled
 * PostToolUse for mid-run flushing) to mirror a terminal `gipity claude`
 * session into the Gipity server so the web CLI can display it read-only.
 *
 * Not a user-facing `gipity` subcommand by design: users never invoke
 * this directly. The Gipity Claude Code plugin's capture hook script
 * (skills repo hooks/scripts/capture.cjs) resolves this file inside the
 * installed CLI at fire time and runs it - so the capture logic versions
 * with the CLI, not the plugin.
 *
 * Usage:
 *   node capture-runner.js <source> <event>
 *   source: 'claude-code' (today) | future: 'codex', …
 *   event:  'session-start' | 'stop' | 'subagent-stop' | 'session-end' | 'post-tool-use'
 *
 * Graceful no-ops (exit 0 silently):
 *   - GIPITY_CONVERSATION_GUID env var unset (hook fired from a bare
 *     `claude`, not `gipity claude`).
 *   - The machine isn't paired - no device token available.
 *   - Anything unexpected (parse error, network error, etc.). We must
 *     not break the user's interactive session.
 */

import {
  existsSync,
  mkdirSync,
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
import {
  parseTranscript,
  type IngestEntry,
} from '../capture/sources/claude-code.js';

const CAPTURE_DIR = join(homedir(), '.gipity', 'capture-state');
const INGEST_BATCH_MAX = 100; // server caps at 200; stay comfortably under

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface StateFile {
  last_uuid: string | null;
  // Wall-clock of the last successful flush. Used to throttle the
  // high-frequency PostToolUse trigger (see POST_TOOL_FLUSH_MS).
  last_flush_ms?: number;
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
    return {
      last_uuid: typeof parsed.last_uuid === 'string' ? parsed.last_uuid : null,
      last_flush_ms: typeof parsed.last_flush_ms === 'number' ? parsed.last_flush_ms : undefined,
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

async function handleSessionStart(convGuid: string, hook: HookInput): Promise<void> {
  if (!hook.session_id) return;
  const existing = readState(convGuid);
  if (!existing) writeState(convGuid, { last_uuid: null });

  const entries: IngestEntry[] = [{
    kind: 'attach',
    session_id: hook.session_id,
    cwd: hook.cwd,
    source: 'startup',
    source_uuid: `${hook.session_id}-attach`,
  }];
  await postEntries(convGuid, entries);
}

async function handleStopFamily(
  convGuid: string, hook: HookInput, isSubagent: boolean, minIntervalMs = 0,
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

    let result = parseTranscript(content, state.last_uuid);
    if (!result.foundWatermark && state.last_uuid !== null) {
      // Transcript rotated (/clear or compact) - watermark isn't present.
      // Replay from top; server dedupes via the source_uuid unique index.
      result = parseTranscript(content, null);
    }

    const ok = await postEntries(convGuid, result.entries);
    if (ok) {
      // Stamp the flush time even when no new lines landed, so the throttle
      // above measures from the last attempt. Keep the watermark if unchanged.
      writeState(convGuid, { last_uuid: result.lastUuid ?? state.last_uuid, last_flush_ms: Date.now() });
    }
  } finally {
    release();
  }
}

async function handleSessionEnd(convGuid: string, hook: HookInput, source: string): Promise<void> {
  // Flush any tail lines one last time - SessionEnd fires after the final
  // Stop, so there's usually nothing new, but a race between Stop and
  // SessionEnd could leave lines behind.
  if (hook.transcript_path && existsSync(hook.transcript_path)) {
    await handleStopFamily(convGuid, hook, false);
  }

  const sessionId = hook.session_id ?? 'unknown';
  const finishedLabel = displayName(source);
  const entries: IngestEntry[] = [{
    kind: 'system',
    content: `${finishedLabel} finished`,
    source_uuid: `${sessionId}-end`,
  }];
  await postEntries(convGuid, entries);

  deleteState(convGuid);
}

function displayName(source: string): string {
  if (source === 'claude-code') return 'Claude Code';
  return source;
}

async function main(): Promise<void> {
  const convGuid = process.env.GIPITY_CONVERSATION_GUID;
  if (!convGuid) return; // bare `claude`, not `gipity claude`
  if (!getDevice()) return; // machine not paired

  const [source, event] = process.argv.slice(2);
  if (!source || !event) return;

  const stdin = await readStdin();
  let hook: HookInput = {};
  if (stdin.trim()) {
    try { hook = JSON.parse(stdin); } catch { /* ignore - event may not require transcript */ }
  }

  try {
    switch (event) {
      case 'session-start':
        await handleSessionStart(convGuid, hook);
        break;
      case 'stop':
        await handleStopFamily(convGuid, hook, false);
        break;
      case 'subagent-stop':
        await handleStopFamily(convGuid, hook, true);
        break;
      case 'post-tool-use':
        // Incremental mid-run flush so an interrupted session keeps its
        // transcript (Stop/SessionEnd only fire on clean exit). Throttled.
        await handleStopFamily(convGuid, hook, false, POST_TOOL_FLUSH_MS);
        break;
      case 'session-end':
        await handleSessionEnd(convGuid, hook, source);
        break;
      default:
        return; // unknown event - silent no-op
    }
  } catch {
    // Never break the user's interactive session. All failures are silent.
  }
}

void main();

/**
 * Gipity relay daemon — the `gipity-relay` long-running helper that backs
 * `gipity relay run`. Runs two concurrent loops against the paired Gipity
 * account using the device's bearer token:
 *
 *   1. Heartbeat every 60s → POST /remote-devices/heartbeat. Drives the
 *      web CLI's presence indicator.
 *   2. Long-poll → GET /remote-devices/next. On a 200 claim, look up the
 *      dispatch's project in the local allowlist, spawn `gipity claude -p
 *      "<msg>"` in that project's cwd, wait for it to exit, POST ack.
 *
 * The conversation stream (prompts, tool calls, assistant output) flows
 * back to the web CLI *automatically* via the capture hooks installed in
 * `.claude/settings.json` — the daemon itself doesn't forward content.
 *
 * Graceful exit:
 *   - SIGINT / SIGTERM → stop both loops, wait for in-flight child, exit 0.
 *   - 401 from heartbeat or /next → device was revoked; exit 0.
 *   - Any other backend error → log and retry with exponential backoff.
 *
 * See docs/feature-backlog/gipity-relay-phases.md (Phase A Step 7).
 */
import { spawn, ChildProcess } from 'child_process';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, closeSync, openSync } from 'fs';
import { stat, readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { homedir, hostname, platform as osPlatform } from 'os';
import { join } from 'path';
import { getApiBaseOverride, getConfig } from '../config.js';
import { getProjectsRoot } from './paths.js';
import { setupClaudeHooks, setupClaudeMd, setupGitignore, DEFAULT_SYNC_IGNORE } from '../setup.js';
import { syncDown } from '../sync.js';
import { getAuth } from '../auth.js';
import { post } from '../api.js';
import * as state from './state.js';
import {
  IngestEntry,
  createLineSplitter,
  parseEvent,
  mapEventToEntries,
} from './stream-json.js';

// Log path — `gipity relay log` tails this file.
export const RELAY_LOG_PATH = join(homedir(), '.gipity', 'relay.log');

// ─── Tunables ──────────────────────────────────────────────────────────
// Match the server hold (30s) plus a small cushion. Server may return 204
// slightly after its own deadline; we accept that. Values can be overridden
// by env for tests.
const HEARTBEAT_INTERVAL_MS   = parseInt(process.env.GIPITY_RELAY_HEARTBEAT_MS || '60000', 10);
const LONG_POLL_TIMEOUT_MS    = parseInt(process.env.GIPITY_RELAY_POLL_TIMEOUT_MS || '35000', 10);
const BACKOFF_BASE_MS         = parseInt(process.env.GIPITY_RELAY_BACKOFF_BASE_MS || '1000', 10);
const BACKOFF_MAX_MS          = parseInt(process.env.GIPITY_RELAY_BACKOFF_MAX_MS || '30000', 10);
const CANCEL_POLL_INTERVAL_MS = parseInt(process.env.GIPITY_RELAY_CANCEL_POLL_MS || '3000', 10);
const MAX_CONCURRENT_DISPATCHES = Math.max(1, parseInt(process.env.GIPITY_RELAY_MAX_CONCURRENT || '6', 10));

// ─── HTTP helpers (device-auth) ────────────────────────────────────────

function apiBase(): string {
  return getApiBaseOverride() || getConfig()?.apiBase || 'https://a.gipity.ai';
}

function deviceToken(): string {
  const d = state.getDevice();
  if (!d) throw new Error('No device registered. Run: gipity login');
  return d.token;
}

/** Normalize Node's `os.platform()` to the server-accepted set. */
function mapPlatform(p: string): 'darwin' | 'linux' | 'win32' {
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
}

/** Create a remote device server-side (user JWT auth) and persist it locally.
 *  Mirrors the one-shot path in relay/onboarding.ts so the daemon can run
 *  cold without the interactive prompts. */
async function registerDevice(): Promise<state.RelayDevice> {
  const name = (hostname() || 'my-pc').trim().slice(0, 100) || 'my-pc';
  const res = await post<{
    data: { short_guid: string; name: string; platform: string; token: string };
  }>('/remote-devices', { name, platform: mapPlatform(osPlatform()) });
  const device: state.RelayDevice = {
    guid: res.data.short_guid,
    name: res.data.name,
    platform: res.data.platform,
    token: res.data.token,
    paired_at: new Date().toISOString(),
  };
  state.setDevice(device);
  state.setRelayEnabled(true);
  return device;
}

/** Forward an outer signal's abort into an inner controller exactly once,
 *  and return a disposer that always detaches the listener. Prevents the
 *  listener leak that would otherwise accumulate on the long-lived shutdown
 *  signal across every deviceFetch() call. */
export function bridgeAbort(outer: AbortSignal, inner: AbortController): () => void {
  if (outer.aborted) {
    inner.abort(outer.reason);
    return () => {};
  }
  const onAbort = () => inner.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

async function deviceFetch(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort('timeout'), timeoutMs) : null;

  // Only bridge when both exist. If there is no timeout controller we pass
  // `signal` straight to fetch() below, so no listener is needed.
  const detach = (signal && controller) ? bridgeAbort(signal, controller) : null;

  try {
    return await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${deviceToken()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal ?? signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (detach) detach();
  }
}

// ─── Logging ───────────────────────────────────────────────────────────
// `gipity-relay` runs detached under launchd/systemd/Task Scheduler. stderr
// is the natural place for structured log lines; systems capture it.
// `debug`-level lines are gated behind --verbose (or GIPITY_RELAY_VERBOSE=1)
// so routine runs don't spam the log, but `gipity relay run --verbose`
// surfaces every dispatch decision for live troubleshooting.
let verboseMode = process.env.GIPITY_RELAY_VERBOSE === '1';
function setVerbose(on: boolean): void { verboseMode = verboseMode || on; }

// ANSI helpers — only colorize when stderr is a TTY.
const TTY = !!(process.stderr as any).isTTY;
const C = {
  dim:   (s: string) => TTY ? `\x1b[2m${s}\x1b[0m` : s,
  bold:  (s: string) => TTY ? `\x1b[1m${s}\x1b[0m` : s,
  red:   (s: string) => TTY ? `\x1b[31m${s}\x1b[0m` : s,
  green: (s: string) => TTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow:(s: string) => TTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:  (s: string) => TTY ? `\x1b[36m${s}\x1b[0m` : s,
  mag:   (s: string) => TTY ? `\x1b[35m${s}\x1b[0m` : s,
};

function hhmmss(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function badge(level: 'debug' | 'info' | 'warn' | 'error'): string {
  switch (level) {
    case 'error': return C.red('✗');
    case 'warn':  return C.yellow('!');
    case 'debug': return C.dim('·');
    default:      return C.green('›');
  }
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    let s: string;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else s = JSON.stringify(v);
    if (s.length > 120) s = s.slice(0, 117) + '…';
    parts.push(`${C.dim(k + '=')}${s}`);
  }
  return parts.length ? '  ' + parts.join(' ') : '';
}

/** Harden `~/.gipity/` + `relay.log` permissions the first time we
 *  write. The log contains dispatch payloads (message previews, session
 *  ids) which must not be readable by other users on a shared machine.
 *  Dir: 0700, file: 0600. No-op on Windows (chmod is a permission hint
 *  only). Runs once per daemon process — `permsLocked` skips rework. */
let permsLocked = false;
function lockLogPerms(dir: string, file: string): void {
  if (permsLocked) return;
  try { chmodSync(dir, 0o700); } catch { /* ignore — best-effort */ }
  // Ensure file exists before chmod; open+close creates it if missing.
  if (!existsSync(file)) {
    try { closeSync(openSync(file, 'a')); } catch { /* ignore */ }
  }
  try { chmodSync(file, 0o600); } catch { /* ignore */ }
  permsLocked = true;
}

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  if (level === 'debug' && !verboseMode) return;
  // Pretty line to stderr for the human watching `gipity relay run`.
  const pretty = `${C.dim(hhmmss())} ${badge(level)} ${C.bold(msg)}${formatExtra(extra)}`;
  process.stderr.write(pretty + '\n');
  // Full JSON mirrored to ~/.gipity/relay.log so `gipity relay log` and
  // any external log collector still see structured data.
  try {
    const dir = join(homedir(), '.gipity');
    mkdirSync(dir, { recursive: true });
    lockLogPerms(dir, RELAY_LOG_PATH);
    const json = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra ?? {}) });
    appendFileSync(RELAY_LOG_PATH, json + '\n');
  } catch { /* ignore */ }
}

// ─── Core daemon ───────────────────────────────────────────────────────

export interface DaemonOptions {
  /** Exit after handling N dispatches. Used by tests to bound the run. */
  maxDispatches?: number;
  /** Overall deadline (ms from start). Used by tests. */
  maxRunMs?: number;
  /** Verbose logging: emit per-dispatch debug entries (project resolution,
   *  session chain decision, full spawn argv). Designed for running
   *  `gipity relay run --verbose` in a terminal to watch live behavior. */
  verbose?: boolean;
}

/** Shared between the two loops so either can trigger shutdown. */
interface Ctx {
  abort: AbortController;
  dispatchesHandled: number;
  shutdownReason: string | null;
}

export async function run(opts: DaemonOptions = {}): Promise<number> {
  if (opts.verbose) setVerbose(true);
  let device = state.getDevice();
  if (!device) {
    // No local device record — try to register transparently using the
    // current user's login. This is the same flow the interactive
    // `gipity claude` onboarding uses; running the daemon directly just
    // skips the prompts.
    if (!getAuth()) {
      log('error', 'not logged in');
      process.stderr.write('Not logged in. Run `gipity login` first.\n');
      return 1;
    }
    try {
      device = await registerDevice();
      log('info', 'device registered', { name: device.name, guid: device.guid });
    } catch (err: any) {
      log('error', 'device registration failed', { err: err?.message || String(err) });
      process.stderr.write(`Could not register this device: ${err?.message || err}\n`);
      process.stderr.write('Run `gipity login` to (re)authenticate, then try again.\n');
      return 1;
    }
  }

  const ctx: Ctx = {
    abort: new AbortController(),
    dispatchesHandled: 0,
    shutdownReason: null,
  };
  const shutdown = (reason: string) => {
    if (ctx.shutdownReason) return;
    ctx.shutdownReason = reason;
    ctx.abort.abort(reason);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (opts.maxRunMs) setTimeout(() => shutdown('maxRunMs'), opts.maxRunMs).unref();

  // Take the PID lock. If another daemon already holds it, exit clean —
  // the caller (usually `gipity claude`'s auto-start) is racing us.
  try {
    state.writeDaemonPid(process.pid);
  } catch (err: any) {
    log('info', 'another daemon is already running — exiting', { err: err?.message });
    if (opts.verbose) {
      process.stderr.write(
        'Another relay daemon is already running (likely the autostarted one).\n' +
        'Stop it first, then retry:  gipity relay autostart uninstall  (or stop the service),\n' +
        'or tail the existing daemon:  gipity relay log -f\n',
      );
    }
    return 0;
  }
  const releasePid = () => state.clearDaemonPid();
  process.on('exit', releasePid);
  // Also release on our shutdown signals (exit handler sometimes doesn't fire).
  ctx.abort.signal.addEventListener('abort', releasePid, { once: true });

  log('info', 'relay started', { device: device.guid, name: device.name, pid: process.pid });

  // Run all loops concurrently; exit when any returns (or abort fires).
  // Cancellation poller runs alongside the dispatch loop so user-initiated
  // cancels reach a running child within a few seconds.
  const stopCode = await Promise.race([
    heartbeatLoop(ctx),
    dispatchLoop(ctx, opts),
    cancellationLoop(ctx),
  ]);

  releasePid();
  log('info', 'relay stopped', { reason: ctx.shutdownReason ?? 'loop-exit', exit: stopCode });
  return stopCode;
}

// ─── Heartbeat loop ────────────────────────────────────────────────────

async function heartbeatLoop(ctx: Ctx): Promise<number> {
  let backoff = 0;
  while (!ctx.abort.signal.aborted) {
    try {
      const r = await deviceFetch('POST', '/remote-devices/heartbeat', {}, 10_000, ctx.abort.signal);
      if (r.status === 401) {
        log('warn', 'heartbeat 401 — device revoked, exiting clean');
        ctx.abort.abort('revoked');
        return 0;
      }
      if (!r.ok) throw new Error(`heartbeat ${r.status}`);
      backoff = 0;
    } catch (err: any) {
      if (ctx.abort.signal.aborted) return 0;
      log('warn', 'heartbeat failed', { err: err?.message });
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_BASE_MS);
      await sleep(backoff, ctx.abort.signal);
      continue;
    }
    await sleep(HEARTBEAT_INTERVAL_MS, ctx.abort.signal);
  }
  return 0;
}

// ─── Cancellation loop ────────────────────────────────────────────────
// Polls the server every few seconds for any dispatch this device is
// running that the user has asked to cancel. On match: SIGTERM the
// matching child — handleDispatch will then ack the dispatch as
// `cancelled` and post a "Claude Code cancelled (…)" marker.

async function cancellationLoop(ctx: Ctx): Promise<number> {
  while (!ctx.abort.signal.aborted) {
    // Only poll when we actually have work to cancel. Skipping idle
    // polls keeps log noise down on a quiet daemon.
    if (getRunningDispatchGuids().length === 0) {
      await sleep(CANCEL_POLL_INTERVAL_MS, ctx.abort.signal);
      continue;
    }
    try {
      const r = await deviceFetch('GET', '/remote-devices/cancellations', undefined, 10_000, ctx.abort.signal);
      if (r.status === 401) {
        log('warn', 'cancellations 401 — device revoked, exiting clean');
        ctx.abort.abort('revoked');
        return 0;
      }
      if (r.ok) {
        const json = await r.json() as { data: { dispatches: Array<{ short_guid: string }> } };
        for (const d of json.data?.dispatches ?? []) {
          if (killDispatch(d.short_guid)) {
            log('info', 'cancelling running dispatch', { id: d.short_guid });
          }
        }
      }
    } catch (err: any) {
      if (ctx.abort.signal.aborted) return 0;
      log('debug', 'cancellations poll error', { err: err?.message });
    }
    await sleep(CANCEL_POLL_INTERVAL_MS, ctx.abort.signal);
  }
  return 0;
}

// ─── Dispatch loop ─────────────────────────────────────────────────────

interface ClaimedDispatch {
  short_guid: string;
  kind: 'start' | 'resume';
  remote_session_id: string | null;
  message: string;
  project_guid: string;
  project_slug: string;
  account_slug: string;
  /** Server-assigned conv guid. We pass it as GIPITY_CONVERSATION_GUID
   *  to the spawned `gipity claude` so every capture hook tags events
   *  with it — no placeholder adoption needed. */
  conversation_guid: string;
  agent_guid: string | null;
}

async function dispatchLoop(ctx: Ctx, opts: DaemonOptions): Promise<number> {
  // In-flight dispatch handlers. Up to MAX_CONCURRENT_DISPATCHES can
  // run at once — each a separate `claude` child in its own cwd/session,
  // so their contexts don't bleed. The cap prevents a user with many
  // open chats from DoS'ing their own laptop.
  const inflight = new Set<Promise<void>>();
  let backoff = 0;

  // Wait until a slot frees up or the daemon is aborted. Polling inflight
  // via Promise.race means we claim the next dispatch the instant a child
  // exits, not on the next fixed tick.
  const waitForSlot = async () => {
    while (inflight.size >= MAX_CONCURRENT_DISPATCHES && !ctx.abort.signal.aborted) {
      await Promise.race([
        ...inflight,
        new Promise<void>(resolve => {
          if (ctx.abort.signal.aborted) return resolve();
          ctx.abort.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
    }
  };

  while (!ctx.abort.signal.aborted) {
    if (opts.maxDispatches != null && ctx.dispatchesHandled >= opts.maxDispatches) {
      ctx.abort.abort('maxDispatches');
      break;
    }

    await waitForSlot();
    if (ctx.abort.signal.aborted) break;

    try {
      const r = await deviceFetch('GET', '/remote-devices/next', undefined, LONG_POLL_TIMEOUT_MS, ctx.abort.signal);
      if (r.status === 401) {
        log('warn', 'next 401 — device revoked, exiting clean');
        ctx.abort.abort('revoked');
        break;
      }
      if (r.status === 204) { backoff = 0; continue; }
      if (!r.ok) throw new Error(`next ${r.status}`);

      const json = await r.json() as { data: ClaimedDispatch };
      const d = json.data;
      if (!d || typeof d.short_guid !== 'string') {
        log('warn', 'claim returned unexpected shape', { snippet: JSON.stringify(json).slice(0, 300) });
        backoff = 0;
        continue;
      }

      // Fire-and-forget: let this dispatch run concurrently with future
      // claims. Counting towards `dispatchesHandled` at claim time (not
      // completion) keeps the maxDispatches test cap predictable.
      ctx.dispatchesHandled++;
      const p: Promise<void> = handleDispatch(d)
        .catch(err => log('error', 'dispatch crashed', { id: d.short_guid, err: err?.message || String(err) }))
        .finally(() => { inflight.delete(p); });
      inflight.add(p);
      backoff = 0;
    } catch (err: any) {
      if (ctx.abort.signal.aborted) break;
      log('warn', 'dispatch-loop error', { err: err?.message });
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_BASE_MS);
      await sleep(backoff, ctx.abort.signal);
    }
  }

  // Drain: let any still-running children finish before declaring stop,
  // so a shutdown doesn't orphan a dispatch mid-spawn. handleDispatch's
  // own ack path closes each out cleanly.
  if (inflight.size > 0) {
    log('info', 'draining in-flight dispatches on shutdown', { count: inflight.size });
    await Promise.allSettled([...inflight]);
  }
  return 0;
}

// ─── Per-dispatch handler ──────────────────────────────────────────────

/** Post a batch of ingest entries with the daemon's device bearer. Returns
 *  whether the server accepted them (2xx). Non-2xx and network errors are
 *  logged but never thrown — the dispatch loop should continue on a missed
 *  post, and the caller decides whether to advance offsets based on `ok`. */
async function postIngest(convGuid: string, entries: IngestEntry[]): Promise<{ ok: boolean }> {
  if (!entries.length) return { ok: true };
  try {
    const res = await deviceFetch('POST', `/remote-sessions/${encodeURIComponent(convGuid)}/ingest`, {
      entries,
    }, 10_000);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('warn', 'ingest post non-2xx', { convGuid, httpStatus: res.status, body: body.slice(0, 200) });
      return { ok: false };
    }
    return { ok: true };
  } catch (err: any) {
    log('warn', 'ingest post network error', { convGuid, err: err?.message });
    return { ok: false };
  }
}

/** 123 B / 4.2 KB / 1.3 MB — short + readable for the "Invoking…" badge. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `12 words (234 B)` or `12 words (234 B; abc12345)`. Pluralizes "word". */
function fmtSize(words: number, bytes: number, suffix?: string): string {
  return `${words} word${words === 1 ? '' : 's'} (${formatBytes(bytes)}${suffix ? `; ${suffix}` : ''})`;
}

// Recursively walk a parsed JSONL record and emit string values that look
// like human-authored content. Intentionally permissive: Claude Code's
// transcript schema drifts, so we match a small set of known text-bearing
// keys and ignore everything else rather than try to be exhaustive.
const TRANSCRIPT_TEXT_KEYS = new Set(['content', 'text', 'message', 'input', 'output']);
function collectStrings(node: unknown, emit: (s: string) => void, underTextKey = false): void {
  if (typeof node === 'string') {
    if (underTextKey) emit(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, emit, underTextKey);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectStrings(v, emit, underTextKey || TRANSCRIPT_TEXT_KEYS.has(k));
    }
  }
}

/** Read a Claude Code session transcript and return its size in bytes plus a
 *  human-content word count. Returns null if the file is missing or unreadable —
 *  caller should render "transcript unavailable" rather than blocking the dispatch. */
async function measureTranscript(transcriptPath: string): Promise<{ bytes: number; words: number } | null> {
  try {
    const { size } = await stat(transcriptPath);
    const raw = await readFile(transcriptPath, 'utf-8');
    let wordCount = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        collectStrings(obj, (s) => {
          const parts = s.trim().split(/\s+/).filter(Boolean);
          wordCount += parts.length;
        });
      } catch { /* malformed line — skip */ }
    }
    return { bytes: size, words: wordCount };
  } catch {
    return null;
  }
}

/** Claude Code's own session_id is expected to be an opaque alphanumeric
 *  token (their docs: UUIDs). We never trust an untyped value to become a
 *  filesystem path segment — a `../../etc/passwd` could otherwise escape
 *  the projects dir. Accept only safe characters; anything else is
 *  treated as "no transcript available" (cosmetic only — stream-json is
 *  the real capture channel). */
function isSafeSessionId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s);
}

/** Resolve Claude Code's on-disk transcript path for measuring resume
 *  size. Claude encodes the project cwd into a slug by replacing `/` with
 *  `-`. We only read this file cosmetically (to show "resume 5 KB" in the
 *  Invoking marker); actual capture is via stream-json. Returns null for
 *  a sessionId that fails the safety check. */
function transcriptPathFor(cwd: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const slug = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/** `18.4s` when under a minute, `3:12.2` above. */
function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

async function ack(shortGuid: string, status: 'done' | 'error' | 'cancelled', error?: string): Promise<void> {
  try {
    const res = await deviceFetch('POST', `/remote-devices/dispatches/${encodeURIComponent(shortGuid)}/ack`, {
      status, error: error ?? null,
    }, 10_000);
    if (!res.ok) {
      // fetch() doesn't throw on 4xx/5xx — surface it ourselves so a
      // broken server route doesn't silently leave dispatches stuck in
      // `delivering` (and therefore no `dispatch:ack` broadcast).
      const body = await res.text().catch(() => '');
      log('warn', 'ack non-2xx', { shortGuid, httpStatus: res.status, body: body.slice(0, 300) });
    }
  } catch (err: any) {
    log('warn', 'ack network error', { shortGuid, err: err?.message });
  }
}

async function handleDispatch(d: ClaimedDispatch): Promise<void> {
  log('info', 'dispatch claimed', { id: d.short_guid, project: d.project_slug, kind: d.kind });
  log('debug', 'dispatch payload', {
    id: d.short_guid,
    project_guid: d.project_guid,
    project_slug: d.project_slug,
    account_slug: d.account_slug,
    kind: d.kind,
    remote_session_id: d.remote_session_id,
    message_preview: d.message.slice(0, 200),
    message_len: d.message.length,
  });

  if (state.isPaused()) {
    log('info', 'paused — nacking dispatch', { id: d.short_guid });
    await ack(d.short_guid, 'error', 'Daemon is paused on this device');
    return;
  }

  if (d.kind === 'resume' && !d.remote_session_id) {
    await ack(d.short_guid, 'error', 'resume dispatch missing remote_session_id');
    return;
  }

  // Kill-on-new-message: if a previous dispatch for this conv is still
  // running, SIGTERM it and wait for it to fully unwind (post its
  // "Claude Code cancelled (…)" marker + ack). The new spawn below will
  // then --resume the same session, loading whatever made it to disk.
  // Two children on one session would corrupt the .jsonl — this is the
  // serialization point that prevents that.
  await killRunningForConv(d.conversation_guid);

  let cwd: string;
  try {
    cwd = await resolveCwdForProject(d);
    log('debug', 'resolved project cwd', { id: d.short_guid, project: d.project_slug, cwd });
  } catch (err: any) {
    log('error', 'could not resolve project cwd', { id: d.short_guid, err: err?.message });
    await ack(d.short_guid, 'error', `Could not materialize project locally: ${err?.message || err}`);
    return;
  }

  // Build argv for `gipity claude -p …` (or with --resume). No shell — argv
  // as array so the message string can't be interpreted as shell syntax.
  //
  // `--permission-mode bypassPermissions`: a relay dispatch has no
  // human on the other end to click "Approve" — Claude prompting would
  // just stall the session. The user authorized this flow by pairing
  // the device and dispatching the message; skipping the interactive
  // prompt is correct (same authority as running `claude -p` in a local
  // terminal yourself).
  const args = ['claude', '-p', d.message, '--permission-mode', 'bypassPermissions'];
  if (d.kind === 'resume' && d.remote_session_id) {
    args.push('--resume', d.remote_session_id);
  }

  log('debug', 'spawning gipity claude', {
    id: d.short_guid,
    cwd,
    args,
    conv: d.conversation_guid,
    chain: d.kind === 'resume' ? `resume ${d.remote_session_id}` : 'start (fresh session)',
  });

  // Measure the Claude Code transcript on resume so we can show the user
  // how much context is being loaded back into the session.
  let transcript: { bytes: number; words: number } | null = null;
  let transcriptPath: string | null = null;
  if (d.kind === 'resume' && d.remote_session_id) {
    transcriptPath = transcriptPathFor(cwd, d.remote_session_id);
    if (transcriptPath) {
      transcript = await measureTranscript(transcriptPath);
      log('info', 'resuming claude session', {
        id: d.short_guid,
        session_id: d.remote_session_id,
        transcript_path: transcriptPath,
        transcript_bytes: transcript?.bytes ?? null,
        transcript_words: transcript?.words ?? null,
      });
      if (!transcript) {
        log('warn', 'resume transcript unreadable', {
          id: d.short_guid,
          session_id: d.remote_session_id,
          transcript_path: transcriptPath,
        });
      }
    } else {
      log('warn', 'resume session_id failed safety check — skipping transcript measure', {
        id: d.short_guid,
        session_id: d.remote_session_id,
      });
    }
  } else {
    log('info', 'starting fresh claude session', { id: d.short_guid });
  }

  // Lifecycle marker: "Running Claude Code - N + M words". Lands in the
  // conv as a role='system' message, visible live + on refresh. Tells
  // the user the relay received + started processing the dispatch even
  // if Claude is slow to respond.
  const words = d.message.trim().split(/\s+/).filter(Boolean).length;
  const counts: string[] = [words.toLocaleString('en-US')];
  let resumeNote = '';
  if (d.kind === 'resume' && d.remote_session_id) {
    if (transcript) {
      counts.push(transcript.words.toLocaleString('en-US'));
    } else {
      resumeNote = ' (resume transcript unavailable)';
    }
  }
  const header = `Running Claude Code - ${counts.join(' + ')} words${resumeNote}`;
  await postIngest(d.conversation_guid, [
    { kind: 'prompt', prompt: d.message },
    { kind: 'system', content: header },
  ]);

  const t0 = Date.now();
  let exitCode = 1;
  let spawnErr: string | null = null;
  let killed = false;
  try {
    const result = await spawnGipityClaude(args, cwd, d);
    exitCode = result.exitCode;
    killed = result.killed;
  } catch (err: any) {
    spawnErr = err?.message || String(err);
    log('error', 'dispatch spawn failed', { id: d.short_guid, err: spawnErr });
  }
  const ms = Date.now() - t0;
  const dur = formatDuration(ms);

  // Push any local files Claude wrote/touched during this dispatch
  // back to VFS. The PostToolUse hook only covers Claude's native
  // Write/Edit tools — Bash-invoked writers (`gipity generate image`,
  // `cwebp`, any script that drops a file) stay local without this.
  // Runs before the ack so the web CLI's post-ack refresh sees new
  // files. Skip on spawn errors (no child ran, nothing changed).
  // Future cleanup: see docs/feature-backlog/future-generate-to-vfs.md
  // — server-side /generate/* should write directly to VFS and make
  // this syncUp redundant for that case.
  if (!spawnErr) {
    try {
      await spawnSyncUp(cwd);
    } catch (err: any) {
      log('warn', 'syncUp after dispatch failed', { id: d.short_guid, err: err?.message });
    }
  }
  const tail = killed
    ? `cancelled (${dur})`
    : spawnErr
      ? `failed (${dur}: ${spawnErr})`
      : exitCode === 0
        ? `finished (${dur})`
        : `failed (${dur}, exit ${exitCode})`;
  await postIngest(d.conversation_guid, [{ kind: 'system', content: `Claude Code ${tail}` }]);

  if (killed) {
    log('info', 'dispatch cancelled by user', { id: d.short_guid, ms });
    await ack(d.short_guid, 'cancelled');
  } else if (spawnErr) {
    await ack(d.short_guid, 'error', spawnErr);
  } else if (exitCode === 0) {
    log('info', 'dispatch done', { id: d.short_guid, ms });
    await ack(d.short_guid, 'done');
  } else {
    log('warn', 'dispatch child exited nonzero', { id: d.short_guid, exitCode, ms });
    await ack(d.short_guid, 'error', `gipity claude exited with code ${exitCode}`);
  }
}

/**
 * Auto-resolve the cwd for a dispatched project. If `~/GipityProjects/<slug>/`
 * exists with a matching .gipity.json, use it. Otherwise create the dir,
 * write the config, install capture hooks, and pull project files — so the
 * user never has to pre-register a project. This replaces the old
 * per-project allowlist.
 */
async function resolveCwdForProject(d: ClaimedDispatch): Promise<string> {
  // Defense-in-depth: server-side slugify() already restricts slugs to
  // [a-z0-9-]{3,50}, but if that ever weakens, an unvalidated slug here
  // means `join(root, "../../etc")` writes outside the projects root on
  // the user's laptop. Reject anything with path separators or `..`.
  if (!/^[a-z0-9-]{1,80}$/i.test(d.project_slug) || d.project_slug.includes('..')) {
    throw new Error(`Invalid project slug: ${JSON.stringify(d.project_slug)}`);
  }
  const root = getProjectsRoot();
  const path = join(root, d.project_slug);

  const configPath = join(path, '.gipity.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (cfg.projectGuid === d.project_guid) return path;
      log('warn', 'project dir exists but guid mismatch — using it anyway', {
        path, expected: d.project_guid, found: cfg.projectGuid,
      });
      return path;
    } catch { /* fall through to re-bootstrap */ }
  }

  log('info', 'bootstrapping new project dir', { slug: d.project_slug, path });
  mkdirSync(path, { recursive: true });
  const apiBase = getApiBaseOverride() || getConfig()?.apiBase || 'https://a.gipity.ai';
  writeFileSync(configPath, JSON.stringify({
    projectGuid: d.project_guid,
    projectSlug: d.project_slug,
    accountSlug: d.account_slug,
    agentGuid: d.agent_guid || '',
    conversationGuid: null,
    apiBase,
    ignore: DEFAULT_SYNC_IGNORE,
  }, null, 2) + '\n');

  // Set up capture hooks + CLAUDE.md + .gitignore in the new dir. These
  // helpers take cwd implicitly — run from the target path.
  const origCwd = process.cwd();
  try {
    process.chdir(path);
    setupClaudeHooks();
    setupClaudeMd();
    setupGitignore();
    try {
      await syncDown({ confirmDeletions: false });
    } catch (err: any) {
      log('warn', 'initial sync-down failed; project dir created but empty', { err: err?.message });
    }
  } finally {
    process.chdir(origCwd);
  }
  return path;
}

/** Registry of live Claude children, keyed by dispatch short_guid. The
 *  cancellation poller SIGTERMs entries here when the server reports a
 *  matching dispatch has been user-cancelled. The kill-on-new-message
 *  path SIGTERMs entries matching an incoming dispatch's conv_guid.
 *
 *  `exited` resolves when the child's `exit` event fires (not when
 *  `killDispatch` is called). Callers that need to wait for cleanup —
 *  e.g. `killRunningForConv` before spawning a replacement — await it
 *  so the outgoing child has a chance to post its cancelled marker and
 *  ack before the new one starts. */
interface RunningEntry {
  child: ChildProcess;
  convGuid: string;
  exited: Promise<void>;
}
const running = new Map<string, RunningEntry>();

export function getRunningDispatchGuids(): string[] {
  return [...running.keys()];
}

export function getRunningConvGuids(): string[] {
  return [...running.values()].map(e => e.convGuid);
}

/** SIGTERM any running child whose conv_guid matches, then wait for each
 *  to fully unwind (exit event fires, handleDispatch acks + posts
 *  cancelled marker). Used at the top of handleDispatch so a new message
 *  for a busy conv cleanly replaces the in-flight one. No-op if no child
 *  matches. */
export async function killRunningForConv(convGuid: string): Promise<void> {
  const matches = [...running.values()].filter(e => e.convGuid === convGuid);
  if (matches.length === 0) return;
  for (const e of matches) {
    log('info', 'interrupting previous dispatch for conv', { conv: convGuid });
    try { e.child.kill('SIGTERM'); } catch { /* ignore — already exited */ }
  }
  await Promise.all(matches.map(e => e.exited));
}

/** Spawn `gipity claude …` in `cwd` with `--output-format stream-json
 *  --verbose` so every event (assistant messages, tool_use blocks,
 *  tool_result blocks, result summary) lands on stdout as NDJSON. Each
 *  line is parsed and POSTed to `/ingest` — no hooks, no transcript
 *  file reads.
 *
 *  Returns `{ exitCode, killed }` where `killed` is true if we SIGTERMed
 *  the child (cancellation). Injectable via GIPITY_RELAY_CLAUDE_CMD env
 *  for tests. */
/** Spawn `gipity sync up` in the project dir to push any local writes
 *  back to VFS. Runs as a child so we inherit `syncUp`'s cwd-walk for
 *  config resolution (the daemon itself doesn't chdir into projects).
 *  Non-blocking on failure — caller catches and logs. */
async function spawnSyncUp(cwd: string): Promise<void> {
  const cmd = process.env.GIPITY_RELAY_CLAUDE_CMD || 'gipity';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ['sync', 'up', '--json'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Drain pipes so the child doesn't stall on a full buffer.
    let stdoutLen = 0;
    let stderrBuf = '';
    child.stdout?.on('data', (b: Buffer) => { stdoutLen += b.length; });
    child.stderr?.on('data', (b: Buffer) => { stderrBuf += b.toString('utf-8'); });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) {
        log('info', 'syncUp after dispatch', { cwd, stdoutLen });
        resolve();
      } else {
        reject(new Error(`gipity sync up exited ${code}${stderrBuf ? `: ${stderrBuf.trim().slice(0, 300)}` : ''}`));
      }
    });
  });
}

export async function spawnGipityClaude(
  args: string[],
  cwd: string,
  d: ClaimedDispatch,
): Promise<{ exitCode: number; killed: boolean }> {
  const cmd = process.env.GIPITY_RELAY_CLAUDE_CMD || 'gipity';
  // Inject stream-json flags here rather than at the call site so every
  // relay spawn path gets the same protocol. `--verbose` is required by
  // Claude Code when combining `-p` with `--output-format stream-json`.
  const fullArgs = [...args, '--output-format', 'stream-json', '--verbose'];
  const env = { ...process.env, GIPITY_CONVERSATION_GUID: d.conversation_guid };

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, fullArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    // `exited` fires when the child fully unwinds (exit event). Callers
    // like `killRunningForConv` await this before spawning a replacement
    // so the outgoing child has a chance to post its cancelled marker
    // and ack the dispatch.
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>(r => { resolveExited = r; });
    running.set(d.short_guid, { child, convGuid: d.conversation_guid, exited });

    // Track in-flight ingest POSTs for this spawn. On exit we await them
    // before resolving the outer promise so `handleDispatch` doesn't
    // move on to its tail marker while the last batch is still in flight.
    const pendingPosts = new Set<Promise<void>>();

    // Stdout: NDJSON stream → parse → POST each event's ingest entries
    // as they arrive. That's the live-streaming path — every assistant
    // message and tool call appears in the web CLI within a second of
    // Claude emitting it.
    const splitter = createLineSplitter((line) => {
      const evt = parseEvent(line, (reason, snippet) => {
        log('warn', 'stream-json parse skipped line', { id: d.short_guid, reason, snippet });
      });
      if (!evt) return;
      const entries = mapEventToEntries(evt);
      if (entries.length === 0) return;
      // Fire-and-forget POST but tracked so the drain on exit can
      // `allSettled` the set before we claim the spawn is done.
      const p: Promise<void> = postIngest(d.conversation_guid, entries)
        .then(() => {})
        .catch(() => {})
        .finally(() => { pendingPosts.delete(p); });
      pendingPosts.add(p);
    });
    child.stdout?.on('data', (chunk) => splitter.push(chunk));
    child.stdout?.on('end', () => splitter.flush());

    // Stderr: human-readable only (Claude's progress bars, errors).
    // Kept on the daemon's own stderr for `gipity relay log`. The
    // readline interface is closed in the error/exit handler so the
    // listener doesn't outlive the child.
    const errPrefix = C.dim('│ ');
    const errRl = child.stderr ? createInterface({ input: child.stderr }) : null;
    errRl?.on('line', (line) => process.stderr.write(errPrefix + line + '\n'));

    let killed = false;
    const cleanup = () => {
      running.delete(d.short_guid);
      errRl?.close();
      resolveExited();
    };
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', async (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') killed = true;
      // Wait for the last in-flight POSTs so the tail marker lands
      // after all content from this spawn. Safe: pendingPosts always
      // settle (catch + finally), so allSettled never hangs.
      if (pendingPosts.size > 0) {
        await Promise.allSettled([...pendingPosts]);
      }
      cleanup();
      resolve({ exitCode: code ?? 1, killed });
    });
  });
}

/** SIGTERM a specific running dispatch. Returns true if one was killed,
 *  false if no such child was running on this daemon. */
export function killDispatch(shortGuid: string): boolean {
  const entry = running.get(shortGuid);
  if (!entry) return false;
  try {
    entry.child.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    let onAbort: (() => void) | null = null;
    const t = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(t); signal.removeEventListener('abort', onAbort!); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

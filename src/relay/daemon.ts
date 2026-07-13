/**
 * Gipity relay daemon - the `gipity-relay` long-running helper that backs
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
 * `.claude/settings.json` - the daemon itself doesn't forward content.
 *
 * Graceful exit:
 *   - SIGINT / SIGTERM → stop both loops, wait for in-flight child, exit 0.
 *   - 401 from heartbeat or /next → device was revoked; exit 0.
 *   - Any other backend error → log and retry with exponential backoff.
 *
 * See platform/docs-team/product/specs/gipity-relay-protocol.md.
 */
import { ChildProcess } from 'child_process';
import { resolveCommand, spawnCommand } from '../platform.js';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, closeSync, openSync, unlinkSync } from 'fs';
import { stat, readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { homedir, hostname, platform as osPlatform, loadavg, freemem, totalmem, cpus } from 'os';
import { join } from 'path';
import { getApiBaseOverride, DEFAULT_API_BASE } from '../config.js';
import { getProjectsRoot } from './paths.js';
import { setupProjectTools, DEFAULT_SYNC_IGNORE } from '../setup.js';
import { getAuth, readAuthFresh, refreshTokenIfNeeded, accessTokenExpired } from '../auth.js';
import { post } from '../api.js';
import * as state from './state.js';
import {
  IngestEntry,
  createLineSplitter,
  parseEvent,
  mapEventToEntries,
} from './stream-json.js';
import { IngestQueue } from './ingest-queue.js';
import { ImageBlockRewriter } from './media-upload.js';
import { DeltaAccumulator, DeltaBatcher } from './stream-delta.js';
import type { DeltaFlush } from './stream-delta.js';
import { randomUUID } from 'crypto';
import { deviceFetch, bridgeAbort as bridgeAbortImpl } from './device-http.js';
import { ensureRelayAgentToken } from './agent-token.js';
import { redactEntries, redactString, normalizeSecrets } from './redact.js';
import { getMachineId } from './machine-id.js';
import { collectDiagnostics } from './diagnostics.js';
import { SessionPool, PoolFullError, type QueryFactory, type SessionStateKind } from './session-pool.js';
import { getConfig } from '../config.js';
import { getAccountSlug } from '../api.js';
import { buildFreshWrap, buildResumeWrap, buildProjectContextBlock } from '../prompts.js';
import { fetchProjectStats } from '../commands/claude.js';

// Re-exported so the existing `relay-bridge-abort.test.ts` keeps working.
// New callers should import from device-http.js directly.
export const bridgeAbort = bridgeAbortImpl;

// Log path - `gipity relay log` tails this file.
export const RELAY_LOG_PATH = join(homedir(), '.gipity', 'relay.log');

// ─── Tunables ──────────────────────────────────────────────────────────
// Match the server hold (30s) plus a small cushion. Server may return 204
// slightly after its own deadline; we accept that. Values can be overridden
// by env for tests.
const HEARTBEAT_INTERVAL_MS   = parseInt(process.env.GIPITY_RELAY_HEARTBEAT_MS || '60000', 10);
// How often the heartbeat carries a fresh diagnostics snapshot (host specs +
// versions). The 60s liveness ping stays bare; only this cadence runs the
// costlier version/GPU probes. First tick fires immediately at daemon start.
const DIAGNOSTICS_INTERVAL_MS = parseInt(process.env.GIPITY_RELAY_DIAGNOSTICS_MS || String(24 * 60 * 60 * 1000), 10);
const LONG_POLL_TIMEOUT_MS    = parseInt(process.env.GIPITY_RELAY_POLL_TIMEOUT_MS || '35000', 10);
const BACKOFF_BASE_MS         = parseInt(process.env.GIPITY_RELAY_BACKOFF_BASE_MS || '1000', 10);
const BACKOFF_MAX_MS          = parseInt(process.env.GIPITY_RELAY_BACKOFF_MAX_MS || '30000', 10);
const CANCEL_POLL_INTERVAL_MS = parseInt(process.env.GIPITY_RELAY_CANCEL_POLL_MS || '3000', 10);
const MAX_CONCURRENT_DISPATCHES = Math.max(1, parseInt(process.env.GIPITY_RELAY_MAX_CONCURRENT || '6', 10));
// Cap how long the pre-Claude project sync (and the post-dispatch push-back) may
// run before we kill it - a stalled sync must never hang a dispatch forever.
const PROJECT_SYNC_TIMEOUT_MS = parseInt(process.env.GIPITY_RELAY_SYNC_TIMEOUT_MS || '120000', 10);

// ─── Phase 2: long-lived session pool (feature-flagged, default OFF) ─────
// When 'on', a conversation's follow-up messages are fed into a live Claude
// Code process (via the Agent SDK) instead of spawning `gipity claude -p`
// each time - faster follow-ups + clean interrupt, at ~300MB RSS per idle
// session. Bounded by a hot window + LRU cap; any pool error or a saturated
// pool falls back to the proven spawn path for that dispatch, so this can
// only make things faster, never break them. Rollback = restart with the
// flag unset.
const SESSION_POOL_ENABLED = process.env.GIPITY_RELAY_SESSION_POOL === 'on';
const SESSION_HOT_MS = parseInt(process.env.GIPITY_RELAY_SESSION_HOT_MS || String(5 * 60_000), 10);
const MAX_SESSIONS = Math.max(1, parseInt(process.env.GIPITY_RELAY_MAX_SESSIONS || '3', 10));

/** System-prompt addendum enabling the interactive question card on the
 *  relay path (AskUserQuestion is unavailable in -p mode). The model emits
 *  a fenced `gipity-question` JSON block instead of asking in prose; the
 *  web CLI swaps it for a clickable card. Kept directive because a soft
 *  "you may" framing let weaker models fall back to prose (Phase 5 spike). */
const GIPITY_QUESTION_PROTOCOL = [
  'INTERACTIVE QUESTIONS: You are running without an interactive terminal, so the user answers you through a web UI.',
  'Whenever you would ask the user a clarifying question or offer them a choice, DO NOT write it as prose.',
  'Instead output ONLY a fenced code block tagged `gipity-question` containing JSON of exactly this shape, then end your turn:',
  '```gipity-question',
  '{"questions":[{"header":"Short label","question":"The question?","options":[{"label":"Choice A","description":"what it means"},{"label":"Choice B","description":"what it means"}],"multiSelect":false}]}',
  '```',
  'Rules: keep option labels short; add a one-line description each; set "multiSelect":true only when several choices can apply; you may include multiple questions in the array; the user can always type a custom answer, so you need not add an "Other" option.',
  'This block is the only way the user can answer, so never ask in plain text when a decision is needed to proceed.',
].join('\n');

// ─── HTTP helpers ──────────────────────────────────────────────────────
// Device-auth fetch lives in ./device-http.ts - shared with the capture
// hook runner so both POST to /remote-sessions/:convGuid/ingest with the
// same Authorization header.

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
  }>('/remote-devices', { name, platform: mapPlatform(osPlatform()), machine_id: getMachineId() });
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

// ─── Logging ───────────────────────────────────────────────────────────
// `gipity-relay` runs detached under launchd/systemd/Task Scheduler. stderr
// is the natural place for structured log lines; systems capture it.
// `debug`-level lines are gated behind --verbose (or GIPITY_RELAY_VERBOSE=1)
// so routine runs don't spam the log, but `gipity relay run --verbose`
// surfaces every dispatch decision for live troubleshooting.
let verboseMode = process.env.GIPITY_RELAY_VERBOSE === '1';

// Agent token exported to spawned children as GIPITY_TOKEN (see agent-token.ts).
// Resolved once at daemon startup; null = fall back to shared session auth.
let relayAgentToken: string | null = null;

/** Environment for relay-spawned `gipity` children. Adds GIPITY_TOKEN when the
 *  daemon holds an agent token so children authenticate statelessly instead of
 *  racing siblings on the session's single-use refresh token. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(relayAgentToken ? { GIPITY_TOKEN: relayAgentToken } : {}),
    ...extra,
  };
}
function setVerbose(on: boolean): void { verboseMode = verboseMode || on; }

// ANSI helpers - only colorize when stderr is a TTY.
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
 *  only). Runs once per daemon process - `permsLocked` skips rework. */
let permsLocked = false;
function lockLogPerms(dir: string, file: string): void {
  if (permsLocked) return;
  try { chmodSync(dir, 0o700); } catch { /* ignore - best-effort */ }
  // Ensure file exists before chmod; open+close creates it if missing. Pass
  // mode 0600 so it's owner-only from creation (no umask-default race window).
  if (!existsSync(file)) {
    try { closeSync(openSync(file, 'a', 0o600)); } catch { /* ignore */ }
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
    // No local device record - try to register transparently using the
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
    // Close any live pool sessions so their claude subprocesses exit with us.
    sessionPool?.shutdown();
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (opts.maxRunMs) setTimeout(() => shutdown('maxRunMs'), opts.maxRunMs).unref();

  // Take the PID lock. Only a *live* daemon should block us: a leftover pid file
  // from an unclean exit (container SIGKILL'd, or `--restart` brought us back on
  // the same filesystem) must not trap us in a permanent restart loop.
  // isDaemonRunning() validates the recorded PID is actually alive and clears
  // the file if it's stale, so writeDaemonPid below can then take the lock.
  if (state.isDaemonRunning()) {
    log('info', 'another daemon is already running - exiting');
    if (opts.verbose) {
      process.stderr.write(
        'Another relay daemon is already running (likely the autostarted one).\n' +
        'Stop it first, then retry:  gipity relay autostart uninstall  (or stop the service),\n' +
        'or tail the existing daemon:  gipity relay log -f\n',
      );
    }
    return 0;
  }
  try {
    state.writeDaemonPid(process.pid);
  } catch (err: any) {
    // Lost a genuine race with another daemon starting at the same instant.
    log('info', 'lost pid-lock race with another daemon - exiting', { err: err?.message });
    return 0;
  }
  const releasePid = () => state.clearDaemonPid();
  process.on('exit', releasePid);
  // Also release on our shutdown signals (exit handler sometimes doesn't fire).
  ctx.abort.signal.addEventListener('abort', releasePid, { once: true });

  // Long-lived agent token for spawned children (gipity sync / gipity claude).
  // With it, children authenticate via GIPITY_TOKEN - stateless, no refresh -
  // instead of racing sibling processes on the session's single-use refresh
  // token. Minting needs a live session; on failure children fall back to
  // session auth (the old behavior), so the daemon still runs.
  relayAgentToken = await ensureRelayAgentToken();
  if (relayAgentToken) {
    log('info', 'agent token ready - spawned children use GIPITY_TOKEN');
  } else {
    log('warn', 'no agent token (mint failed or session dead) - children fall back to session auth');
  }

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
  // Log the "session expired" warning only on the transition into that state,
  // not every 60s, so a genuinely-lapsed session doesn't spam the relay log.
  let sessionWarnLogged = false;
  // Diagnostics: attach a fresh snapshot on the first heartbeat and every
  // DIAGNOSTICS_INTERVAL_MS after, but only if the user consented. Between
  // refreshes the heartbeat is a bare liveness ping.
  let lastDiagnosticsAt = 0;
  while (!ctx.abort.signal.aborted) {
    try {
      let body: Record<string, unknown> = {};
      if (state.diagnosticsConsented() && Date.now() - lastDiagnosticsAt >= DIAGNOSTICS_INTERVAL_MS) {
        try {
          body = { diagnostics: await collectDiagnostics() };
          lastDiagnosticsAt = Date.now();
        } catch (err: any) {
          // Never let a diagnostics probe failure block the liveness ping.
          log('debug', 'diagnostics collection failed', { err: err?.message });
        }
      }
      // Phase 2: report which conversations have a live (hot/running) session
      // so the web indicator can show fast-follow-up readiness. Only when the
      // pool is enabled and has live sessions - a bare ping otherwise.
      if (SESSION_POOL_ENABLED) {
        const sessions = getLiveSessionStates();
        if (sessions.length > 0) body.sessions = sessions.map(s => ({ conversation_guid: s.convGuid, state: s.state }));
      }
      const r = await deviceFetch('POST', '/remote-devices/heartbeat', body, 10_000, ctx.abort.signal);
      if (r.status === 401) {
        log('warn', 'heartbeat 401 - device revoked, exiting clean');
        ctx.abort.abort('revoked');
        return 0;
      }
      if (!r.ok) throw new Error(`heartbeat ${r.status}`);
      backoff = 0;

      // Keep the USER session warm alongside the device heartbeat. The device
      // token (used for this heartbeat and to claim dispatches) is a SEPARATE,
      // long-lived credential from the user's OAuth session in auth.json — a
      // healthy heartbeat says nothing about whether `gipity sync` / `gipity
      // claude` can authenticate. The relay is long-lived but the access token
      // lives only ~1h and the refresh token ~7d; left idle between dispatches
      // the session lapses and the next dispatch's child scrambles to refresh
      // (or finds it dead). Refreshing here — in the long-lived PARENT (never
      // SIGKILL'd mid-rotate the way a per-dispatch child can be), under the
      // shared cross-process auth lock — renews BOTH tokens well inside their
      // windows (each refresh mints a fresh 7-day token), so a continuously
      // running relay never gets bumped out from disuse, and dispatch children
      // hit refreshTokenIfNeeded's fast path instead of racing to rotate the
      // single-use token. Best-effort: it no-ops while the token is still fresh
      // and never throws. If it can't renew, the session is genuinely dead —
      // log it once so `gipity relay log` shows why dispatches will fail until
      // the user re-logs in (nothing here can revive it without a TTY).
      if (getAuth()) {
        try {
          await refreshTokenIfNeeded();
          if (accessTokenExpired() && !sessionWarnLogged) {
            log('warn', 'user session expired - dispatches will fail to sync until re-login (run: gipity login)');
            sessionWarnLogged = true;
          } else if (!accessTokenExpired()) {
            sessionWarnLogged = false;
          }
        } catch (err: any) {
          log('debug', 'session warm failed', { err: err?.message });
        }
      }
    } catch (err: any) {
      if (ctx.abort.signal.aborted) return 0;
      log('warn', 'heartbeat failed', { err: err?.message });
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_BASE_MS);
      await sleep(backoff, ctx.abort.signal);
      continue;
    }
    // Sleep until the next tick OR a session-state poke (whichever first), so
    // the indicator flips promptly on a session opening/closing.
    await Promise.race([
      sleep(HEARTBEAT_INTERVAL_MS, ctx.abort.signal),
      new Promise<void>(resolve => { heartbeatPoke = () => { heartbeatPoke = null; resolve(); }; }),
    ]);
    heartbeatPoke = null;
  }
  return 0;
}

// ─── Cancellation loop ────────────────────────────────────────────────
// Polls the server every few seconds for any dispatch this device is
// running that the user has asked to cancel. On match: SIGTERM the
// matching child - handleDispatch will then ack the dispatch as
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
        log('warn', 'cancellations 401 - device revoked, exiting clean');
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
  /** Server-assigned conv guid. Passed as GIPITY_CONVERSATION_GUID to
   *  the spawned `gipity claude` wrapper so it skips its "create a new
   *  conv" path. The wrapper does NOT propagate this var to the Claude
   *  child when `--output-format stream-json` is active (i.e. for relay
   *  dispatches) - the daemon captures via stdout, and hook capture
   *  would double-post every event. See claude.ts childEnv gate. */
  conversation_guid: string;
  agent_guid: string | null;
  /** Concrete model id the user picked for this chat via `/model`, or null to
   *  use the local agent's own default. Forwarded to the spawned agent as
   *  `--model`. Resolved server-side at claim time, so the latest choice wins. */
  model: string | null;
  /** Files the user attached in the web CLI, already uploaded into the
   *  project VFS at these project-relative paths. The message text already
   *  carries a server-appended note listing them; the daemon's job is to
   *  pull them into the local tree (sync) before launching the agent. */
  attachments: Array<{ path: string; original_name: string; media_type: string; bytes: number }> | null;
}

async function dispatchLoop(ctx: Ctx, opts: DaemonOptions): Promise<number> {
  // In-flight dispatch handlers. Up to MAX_CONCURRENT_DISPATCHES can
  // run at once - each a separate `claude` child in its own cwd/session,
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
        log('warn', 'next 401 - device revoked, exiting clean');
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

/** Collect the secret strings the daemon must scrub from every captured
 *  entry before it reaches the web CLI: the shared Claude credential
 *  (whichever of the two env vars Claude Code is using) and this host's own
 *  Gipity + device tokens.
 *
 *  Cached with a 1s TTL: the stream-delta path calls this for EVERY emitted
 *  span (tens/sec during fast generation), and each call does two sync
 *  file reads (auth.json + device state). A 1s staleness window is well
 *  within the tokens' ~15min lifetime, and the JWT/sk-ant pattern passes in
 *  redactString are the backstop if a refresh lands mid-window. */
let relaySecretsCache: { secrets: string[]; at: number } | null = null;
const RELAY_SECRETS_TTL_MS = 1000;
function getRelaySecrets(): string[] {
  const now = Date.now();
  if (relaySecretsCache && now - relaySecretsCache.at < RELAY_SECRETS_TTL_MS) {
    return relaySecretsCache.secrets;
  }
  const auth = readAuthFresh();
  const device = state.getDevice();
  const secrets = normalizeSecrets([
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    auth?.accessToken,
    auth?.refreshToken,
    device?.token,
  ]);
  relaySecretsCache = { secrets, at: now };
  return secrets;
}

/** Post a batch of ingest entries with the daemon's device bearer. Returns
 *  whether the server accepted them (2xx). Non-2xx and network errors are
 *  logged but never thrown - the dispatch loop should continue on a missed
 *  post, and the caller decides whether to advance offsets based on `ok`.
 *
 *  Every entry is run through `redactEntries` first: a dispatched
 *  `bypassPermissions` session can read the host's credentials, so this is
 *  the single chokepoint that keeps a leaked secret out of the transcript. */
// Server-side per-entry length caps (remote-sessions.ts ingest schema). The
// server rejects the ENTIRE batch with a 400 if any entry violates one, which
// would drop good content (and, for the prompt echo, the "Running…" marker
// batched with it). We clamp defensively here so a batch never 400s on length
// - truncating an over-long value is strictly better than losing the batch.
const INGEST_PROMPT_MAX = 200_000;
const INGEST_ASSISTANT_MAX = 500_000;
const INGEST_SYSTEM_MAX = 500;
const TRUNCATE_SUFFIX = '… [truncated]';

function clampText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

/** Clamp the human-text fields that have server caps. Runs AFTER redaction so
 *  truncation can't split a secret past the literal-match scrubber. Exported
 *  for unit testing. */
export function clampForIngest(entries: IngestEntry[]): IngestEntry[] {
  return entries.map(e => {
    if (e.kind === 'prompt') return { ...e, prompt: clampText(e.prompt, INGEST_PROMPT_MAX) };
    if (e.kind === 'assistant') return { ...e, text: clampText(e.text, INGEST_ASSISTANT_MAX) };
    if (e.kind === 'system') return { ...e, content: clampText(e.content, INGEST_SYSTEM_MAX) };
    return e;
  });
}

async function postIngest(convGuid: string, entries: IngestEntry[]): Promise<{ ok: boolean; retryable?: boolean }> {
  if (!entries.length) return { ok: true };
  const safeEntries = clampForIngest(redactEntries(entries, getRelaySecrets()));
  try {
    const res = await deviceFetch('POST', `/remote-sessions/${encodeURIComponent(convGuid)}/ingest`, {
      entries: safeEntries,
    }, 10_000);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('warn', 'ingest post non-2xx', { convGuid, httpStatus: res.status, body: body.slice(0, 200) });
      // 5xx/429 are transient - worth the queue retrying. A definitive 4xx
      // (schema rejection, missing conv) can never succeed on replay;
      // retrying it would just stall the queue behind a poisoned batch.
      return { ok: false, retryable: res.status >= 500 || res.status === 429 };
    }
    return { ok: true };
  } catch (err: any) {
    log('warn', 'ingest post network error', { convGuid, err: err?.message });
    return { ok: false, retryable: true };
  }
}

/** Fire-and-forget dispatch progress heartbeat. Broadcast-only on the
 *  server (no DB write); a dropped tick just means the web CLI misses one
 *  liveness update and falls back to its own idle detector, so we don't
 *  retry and don't surface non-2xx as an error. */
async function postProgress(
  convGuid: string,
  payload: {
    dispatch_guid: string;
    proc_alive: boolean;
    stdout_bytes_total: number;
    stdout_bytes_delta: number;
    stdout_idle_ms: number;
    uptime_ms: number;
    // Phase enrichment (mirrors @easyclaw/shared DispatchProgressPayload;
    // the packages don't share code, the server schema is the contract).
    phase?: 'starting' | 'thinking' | 'responding' | 'tool' | 'retry' | 'finishing';
    current_tool?: string;
    current_tool_hint?: string;
    tool_elapsed_ms?: number;
    last_event_ms?: number;
    retry?: { attempt: number; max?: number };
  },
): Promise<void> {
  try {
    await deviceFetch('POST', `/remote-sessions/${encodeURIComponent(convGuid)}/progress`, payload, 5_000);
  } catch {
    /* best-effort */
  }
}

/** Fire-and-forget token-delta flush. Ephemeral by design (no DB write
 *  server-side, no retry here): a lost flush shows as a small `…` gap and
 *  the next refresh replaces the streamed view with the stored message. */
async function postStreamDelta(convGuid: string, dispatchGuid: string, flush: DeltaFlush): Promise<void> {
  try {
    await deviceFetch('POST', `/remote-sessions/${encodeURIComponent(convGuid)}/stream-delta`, {
      dispatch_guid: dispatchGuid,
      seq: flush.seq,
      events: flush.events,
    }, 5_000);
  } catch {
    /* best-effort */
  }
}

// ─── Dispatch phase tracker ─────────────────────────────────────────────
// Derives "what is Claude doing right now" purely from events the daemon
// already parses - no extra child instrumentation. Drives the progress
// line's phase enrichment ("⚒ Bash · 0:45 · npm run build" instead of
// the byte-based Working/Quiet guess).

type DispatchPhase = 'starting' | 'thinking' | 'responding' | 'tool' | 'retry' | 'finishing';

/** Short human hint for a tool call shown on the progress line. */
export function toolHint(name: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (name === 'Bash' && typeof input.command === 'string') return input.command;
  const path = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description;
  return typeof path === 'string' ? path : undefined;
}

export class PhaseTracker {
  phase: DispatchPhase = 'starting';
  lastEventAt = Date.now();
  retry: { attempt: number; max?: number } | null = null;
  /** Insertion-ordered open tool calls (tool_use seen, no tool_result yet). */
  private openTools = new Map<string, { name: string; hint?: string; startedAt: number }>();

  note(evt: { type: string; [k: string]: any }): void {
    this.lastEventAt = Date.now();
    // Token deltas refine the phase in real time: thinking fragments mean
    // thinking, text fragments mean responding. Subagent streams
    // (parent_tool_use_id) don't perturb the main phase - the open Task
    // tool_use already puts us in the 'tool' phase.
    if (evt.type === 'stream_event') {
      if (evt.parent_tool_use_id) return;
      const d = evt.event?.delta;
      if (this.openTools.size === 0 && d) {
        if (typeof d.thinking === 'string') this.phase = 'thinking';
        else if (typeof d.text === 'string') this.phase = 'responding';
      }
      return;
    }
    if (evt.type === 'system') {
      // thinking_tokens fires per thinking chunk - the only signal we get
      // during long extended thinking without partial messages.
      if (evt.subtype === 'thinking_tokens' && this.openTools.size === 0) this.phase = 'thinking';
      else if (evt.subtype === 'api_retry') {
        this.retry = {
          attempt: typeof evt.attempt === 'number' ? evt.attempt : 1,
          max: typeof evt.max_retries === 'number' ? evt.max_retries : undefined,
        };
        this.phase = 'retry';
      }
      return;
    }
    if (evt.type === 'assistant') {
      this.retry = null;
      const content = Array.isArray(evt.message?.content) ? evt.message.content : [];
      for (const b of content) {
        if (b?.type === 'tool_use' && typeof b.id === 'string') {
          this.openTools.set(b.id, {
            name: typeof b.name === 'string' ? b.name : 'tool',
            hint: toolHint(b.name, b.input),
            startedAt: Date.now(),
          });
        }
      }
      this.phase = this.openTools.size > 0 ? 'tool' : 'responding';
      return;
    }
    if (evt.type === 'user') {
      const content = Array.isArray(evt.message?.content) ? evt.message.content : [];
      for (const b of content) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') this.openTools.delete(b.tool_use_id);
      }
      // Tool results feed the next model turn - thinking until proven otherwise.
      if (this.openTools.size === 0 && this.phase === 'tool') this.phase = 'thinking';
      return;
    }
    if (evt.type === 'result') this.phase = 'finishing';
  }

  /** The most recently started still-open tool, if any. */
  currentTool(): { name: string; hint?: string; startedAt: number } | null {
    let last: { name: string; hint?: string; startedAt: number } | null = null;
    for (const t of this.openTools.values()) last = t;
    return last;
  }
}

/** 123 B / 4.2 KB / 1.3 MB - short + readable for the "Invoking…" badge. */
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
 *  human-content word count. Returns null if the file is missing or unreadable -
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
      } catch { /* malformed line - skip */ }
    }
    return { bytes: size, words: wordCount };
  } catch {
    return null;
  }
}

/** Claude Code's own session_id is expected to be an opaque alphanumeric
 *  token (their docs: UUIDs). We never trust an untyped value to become a
 *  filesystem path segment - a `../../etc/passwd` could otherwise escape
 *  the projects dir. Accept only safe characters; anything else is
 *  treated as "no transcript available" (cosmetic only - stream-json is
 *  the real capture channel). */
function isSafeSessionId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s);
}

/** Resolve Claude Code's on-disk transcript path for measuring resume
 *  size. Claude encodes the project cwd into a slug by replacing every
 *  non-alphanumeric char with `-` (so `/`, and on Windows `\` and `:`, all
 *  collapse). We only read this file cosmetically (to show "resume 5 KB" in
 *  the Invoking marker); actual capture is via stream-json. Returns null for
 *  a sessionId that fails the safety check. */
function transcriptPathFor(cwd: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
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

// The server's ack schema caps `error` at 2000 chars and 400s anything longer
// - which would leave the dispatch stuck in `delivering` forever (no ack, no
// broadcast, a permanent queue-cap slot). Some error strings we build embed an
// arbitrary OS/spawn message, so clamp here to stay under the cap.
const MAX_ACK_ERROR_CHARS = 2000;

async function ack(shortGuid: string, status: 'done' | 'error' | 'cancelled', error?: string, metrics?: Record<string, number>): Promise<void> {
  // Redact BEFORE clamping (truncation must not split a secret past the
  // literal-match scrubber). The ack `error` is broadcast to the web CLI
  // and rendered - it can embed a spawn message or the child's stderr
  // tail, which on a hosted relay could echo a host credential. The twin
  // ingest system-marker is already redacted via redactEntries; this
  // path was the redaction hole (findings: security review 2026-07-03).
  const safeError = error != null
    ? redactString(error, getRelaySecrets()).slice(0, MAX_ACK_ERROR_CHARS)
    : null;
  try {
    const res = await deviceFetch('POST', `/remote-devices/dispatches/${encodeURIComponent(shortGuid)}/ack`, {
      status, error: safeError, ...(metrics ? { metrics } : {}),
    }, 10_000);
    if (!res.ok) {
      // fetch() doesn't throw on 4xx/5xx - surface it ourselves so a
      // broken server route doesn't silently leave dispatches stuck in
      // `delivering` (and therefore no `dispatch:ack` broadcast).
      const body = await res.text().catch(() => '');
      log('warn', 'ack non-2xx', { shortGuid, httpStatus: res.status, body: body.slice(0, 300) });
    }
  } catch (err: any) {
    log('warn', 'ack network error', { shortGuid, err: err?.message });
  }
}

async function handleDispatch(claimed: ClaimedDispatch): Promise<void> {
  let d = claimed;
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
    log('info', 'paused - nacking dispatch', { id: d.short_guid });
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
  // Two children on one session would corrupt the .jsonl - this is the
  // serialization point that prevents that.
  const { killedSessionIds } = await killRunningForConv(d.conversation_guid);

  // start→resume upgrade: a dispatch can arrive as kind='start' while the
  // conversation ALREADY has a session locally - the server enqueued it
  // before the first run's SessionStart reached it (fast follow-up). Spawning
  // fresh would orphan that session and lose the first turn's context;
  // resume the session the killed child announced (or the last one this conv
  // was seen using) instead.
  if (d.kind === 'start') {
    const sid = killedSessionIds.find(isSafeSessionId) ?? lastSessionForConv(d.conversation_guid);
    if (sid) {
      log('info', 'upgrading start → resume (conv already has a local session)', {
        id: d.short_guid, session_id: sid, from_kill: killedSessionIds.length > 0,
      });
      d = { ...d, kind: 'resume', remote_session_id: sid };
    }
  }

  // One ordered ingest queue per dispatch: markers, prompt echo, stream
  // entries, and the tail all flow through it in order, with backoff
  // retry instead of the old fire-and-forget loss on network errors.
  // Daemon-authored entries get a random source_uuid so retried batches
  // dedup server-side.
  // The rewriter uploads any base64 image blocks (Read-of-screenshot
  // results) to VFS and swaps in image_ref blocks before the batch posts —
  // transcripts carry URLs, never image bytes. Retries re-enter it, which
  // is safe: rewritten entries have nothing left to upload, and the server
  // stores by content hash so a replayed upload dedups.
  const rewriter = new ImageBlockRewriter(
    d.conversation_guid,
    (msg, meta) => log('warn', msg, { id: d.short_guid, ...meta }),
  );
  const queue = new IngestQueue(
    async (entries) => postIngest(d.conversation_guid, await rewriter.rewrite(entries)),
    { onWarn: (msg, meta) => log('warn', msg, { id: d.short_guid, ...meta }) },
  );
  const pushSystem = (content: string) => {
    queue.push({ kind: 'system', content, ts: new Date().toISOString(), source_uuid: randomUUID() });
  };
  /** Drain the queue (bounded) so content lands before the ack that
   *  closes the web CLI's live view. */
  const flushQueue = async () => { await queue.close(30_000); };

  let cwd: string;
  let bootstrapped: boolean;
  try {
    ({ cwd, bootstrapped } = await resolveCwdForProject(d));
    // Lets the rewriter map an absolute Read path (…/screenshots/x.png)
    // to its project-relative VFS path for content-hash dedup.
    rewriter.setCwd(cwd);
    log('debug', 'resolved project cwd', { id: d.short_guid, project: d.project_slug, cwd, bootstrapped });
  } catch (err: any) {
    log('error', 'could not resolve project cwd', { id: d.short_guid, err: err?.message });
    await ack(d.short_guid, 'error', `Could not materialize project locally: ${err?.message || err}`);
    return;
  }

  // Explicit, user-visible, timeout-bounded project sync BEFORE starting Claude -
  // on a freshly bootstrapped dir (the files aren't there yet), and whenever the
  // dispatch carries web-attached files (they were just uploaded to the project
  // VFS; pull them so the agent finds them at the paths the message names).
  // A hung/slow sync is killed at PROJECT_SYNC_TIMEOUT_MS and reported instead
  // of silently stalling the dispatch.
  const hasAttachments = (d.attachments?.length ?? 0) > 0;
  if (bootstrapped || hasAttachments) {
    pushSystem(bootstrapped ? 'Syncing project files…' : 'Syncing attached files…');
    let syncKilled = false;
    let syncFailed = false;
    try {
      syncKilled = (await runDispatchSync(d, cwd)).killed;
    } catch (err: any) {
      const msg = `project sync ${err?.message || 'failed'}`;
      if (!bootstrapped) {
        syncFailed = true;
        // Attachment pre-sync on an EXISTING tree: degrade instead of
        // aborting - the message's attachment note already tells the agent
        // to `gipity sync` any missing file itself, and the rest of the
        // project is present. Only a bootstrap (no files at all) is fatal.
        log('error', 'attachment pre-sync failed - continuing', { id: d.short_guid, err: err?.message });
        pushSystem(`Attached-file sync failed (${err?.message || 'failed'}) - Claude will sync on demand.`);
      } else {
        log('error', 'project sync failed - aborting dispatch', { id: d.short_guid, err: err?.message });
        pushSystem(`Claude Code not started - ${msg}`);
        await flushQueue();
        await ack(d.short_guid, 'error', msg);
        return;
      }
    }
    if (syncKilled) {
      // The user cancelled (or a newer message for this conv superseded us)
      // WHILE the pre-Claude sync was running. Before this was registered in
      // `running`, a cancel was silently ignored until the 120s sync timeout.
      log('info', 'dispatch cancelled during project sync', { id: d.short_guid });
      pushSystem('Claude Code cancelled (during project sync)');
      await flushQueue();
      await ack(d.short_guid, 'cancelled');
      return;
    }
    if (!syncFailed) pushSystem(bootstrapped ? 'Project files synced.' : 'Attached files synced.');
  }

  // Phase 2: if the session pool is enabled, try to run this turn in a
  // long-lived Claude Code session (fast follow-up + clean interrupt). Any
  // failure - pool saturated, SDK error, wrap failure - falls through to the
  // proven spawn path below, so the pool can only ever make things faster.
  if (SESSION_POOL_ENABLED) {
    const handled = await tryHandleViaPool(d, cwd, queue, pushSystem, flushQueue);
    if (handled) return;
  }

  // Build argv for `gipity claude -p …` (or with --resume). No shell - argv
  // as array so the message string can't be interpreted as shell syntax.
  //
  // `--permission-mode bypassPermissions`: a relay dispatch has no
  // human on the other end to click "Approve" - Claude prompting would
  // just stall the session. The user authorized this flow by pairing
  // the device and dispatching the message; skipping the interactive
  // prompt is correct (same authority as running `claude -p` in a local
  // terminal yourself).
  const args = ['claude', '-p', d.message, '--permission-mode', 'bypassPermissions'];
  // Relay sessions run in -p mode, where Claude Code's AskUserQuestion tool
  // is unavailable - so without help the model would ask clarifying
  // questions as prose the user just types back. This system-prompt
  // addendum gives it a structured channel: emit a fenced gipity-question
  // block, which the web CLI renders as an interactive card (clickable
  // options + free-text). Verified to work down to Haiku (Phase 5 spike).
  args.push('--append-system-prompt', GIPITY_QUESTION_PROTOCOL);
  // Per-chat model: the user picked it with `/model` in the web CLI. `gipity
  // claude` forwards --model straight through to the `claude` binary, which
  // honors it on both a fresh session and a --resume. null => agent default.
  if (d.model) {
    args.push('--model', d.model);
  }
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
      log('warn', 'resume session_id failed safety check - skipping transcript measure', {
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
  const ts = new Date().toISOString();
  queue.push(
    { kind: 'prompt', prompt: d.message, ts, source_uuid: randomUUID() },
    { kind: 'system', content: header, ts, source_uuid: randomUUID() },
  );

  const t0 = Date.now();
  let exitCode = 1;
  let spawnErr: string | null = null;
  let killed = false;
  let runtimeLimit = false;
  let stderrTail = '';
  let startupMs: number | undefined;
  try {
    const result = await spawnGipityClaude(args, cwd, d, queue, { resumeWords: transcript?.words });
    exitCode = result.exitCode;
    killed = result.killed;
    runtimeLimit = result.runtimeLimit ?? false;
    stderrTail = result.stderrTail ?? '';
    startupMs = result.startupMs;
  } catch (err: any) {
    spawnErr = err?.message || String(err);
    log('error', 'dispatch spawn failed', { id: d.short_guid, err: spawnErr });
  }
  const ms = Date.now() - t0;
  const dur = formatDuration(ms);

  // Push any local files Claude wrote/touched during this dispatch
  // back to VFS. The PostToolUse hook only covers Claude's native
  // Write/Edit tools - Bash-invoked writers (`gipity generate image`,
  // `cwebp`, any script that drops a file) stay local without this.
  // Runs before the ack so the web CLI's post-ack refresh sees new
  // files. Skip on spawn errors (no child ran, nothing changed).
  // Future cleanup: see docs/feature-backlog/future-generate-to-vfs.md
  // - server-side /generate/* should write directly to VFS and make
  // this sync redundant for that case.
  //
  // Skip on `killed`: a kill-on-new-message replacement is already starting for
  // this conv, and a bidirectional reconcile over the half-finished tree of the
  // cancelled run is exactly the WS-00172 stale-state trap - it pushes/pulls a
  // partial state that the resuming run then fights. The replacement dispatch
  // runs its own sync; let it own the tree.
  if (!spawnErr && !killed) {
    try {
      await spawnSync(cwd, PROJECT_SYNC_TIMEOUT_MS);
    } catch (err: any) {
      log('warn', 'sync after dispatch failed', { id: d.short_guid, err: err?.message });
    }
  }
  // Nonzero exit with no useful message: include the child's last few
  // stderr lines so the visible marker carries the real error instead of
  // just an exit code (previously stderr only reached the daemon's log).
  const stderrNote = stderrTail ? `: ${stderrTail.slice(0, 300)}` : '';
  const tail = runtimeLimit
    ? `stopped after ${dur} (runtime limit)`
    : killed
      ? `cancelled (${dur})`
      : spawnErr
        ? `failed (${dur}: ${spawnErr})`
        : exitCode === 0
          ? `finished (${dur})`
          : `failed (${dur}, exit ${exitCode}${stderrNote})`;
  pushSystem(`Claude Code ${tail}`);
  await flushQueue();

  // Observability: how long the relay took before the agent produced its
  // first output (project sync + Claude Code cold start + MCP). Recorded on
  // the dispatch row; tracked, not enforced. Undefined if the child never
  // emitted an event (spawn failure).
  const metrics = startupMs !== undefined ? { startup_ms: startupMs } : undefined;

  if (runtimeLimit) {
    log('warn', 'dispatch hit runtime limit', { id: d.short_guid, ms });
    await ack(d.short_guid, 'error', `Claude Code stopped after ${dur} (runtime limit)`, metrics);
  } else if (killed) {
    log('info', 'dispatch cancelled by user', { id: d.short_guid, ms });
    await ack(d.short_guid, 'cancelled');
  } else if (spawnErr) {
    await ack(d.short_guid, 'error', spawnErr);
  } else if (exitCode === 0) {
    log('info', 'dispatch done', { id: d.short_guid, ms, startupMs });
    await ack(d.short_guid, 'done', undefined, metrics);
  } else {
    log('warn', 'dispatch child exited nonzero', { id: d.short_guid, exitCode, ms });
    await ack(d.short_guid, 'error', `gipity claude exited with code ${exitCode}${stderrNote}`);
  }
}

/**
 * Wrap the user's raw message with the same project-context / resume framing
 * the `gipity claude` wrapper applies on the spawn path (see claude.ts). The
 * pool bypasses that wrapper, so it must replicate it or the model loses the
 * Gipity context. `resume` => short framing (context already loaded); fresh
 * => full context block (one stats call, cold path only).
 */
async function wrapPoolMessage(d: ClaimedDispatch, cwd: string, resume: boolean): Promise<string> {
  const config = getConfig();
  let accountSlug = '';
  try { accountSlug = await getAccountSlug(); } catch { /* best effort */ }
  const ctx = {
    projectName: config?.projectSlug ?? d.project_slug ?? 'this project',
    projectSlug: config?.projectSlug ?? d.project_slug ?? '',
    projectGuid: config?.projectGuid ?? d.project_guid ?? '',
    accountSlug,
    cwd,
  };
  if (resume) return buildResumeWrap(ctx, d.message);
  const stats = await fetchProjectStats(ctx.projectGuid, cwd);
  return buildFreshWrap(buildProjectContextBlock({ ...ctx, ...stats }), d.message);
}

/**
 * Phase 2 turn: run a dispatch in a long-lived pool session. Reuses the
 * caller's ingest `queue` + markers so the web live view is identical to the
 * spawn path. Returns true if it handled the dispatch (including acking it),
 * false if it declined (pool saturated / not-yet-created error) so the caller
 * falls back to a legacy spawn. Never throws.
 */
async function tryHandleViaPool(
  d: ClaimedDispatch,
  cwd: string,
  queue: IngestQueue,
  pushSystem: (content: string) => void,
  flushQueue: () => Promise<void>,
): Promise<boolean> {
  let pool: SessionPool;
  try {
    pool = await getSessionPool();
  } catch (err: any) {
    log('warn', 'session pool unavailable - falling back to spawn', { id: d.short_guid, err: err?.message });
    return false;
  }

  const wasLive = pool.stateFor(d.conversation_guid) !== 'cold';
  // Resume framing when the pool already has a live session, OR the
  // conversation has a known Claude session id to resume into a fresh one.
  const resumeSessionId = d.kind === 'resume' && d.remote_session_id
    ? d.remote_session_id
    : lastSessionForConv(d.conversation_guid);
  const resume = wasLive || !!resumeSessionId;

  let message: string;
  try {
    message = await wrapPoolMessage(d, cwd, resume);
  } catch (err: any) {
    log('warn', 'pool message wrap failed - falling back to spawn', { id: d.short_guid, err: err?.message });
    return false;
  }

  // Prompt echo + "Running Claude Code" marker, matching the spawn path.
  const words = d.message.trim().split(/\s+/).filter(Boolean).length;
  const ts0 = new Date().toISOString();
  queue.push(
    { kind: 'prompt', prompt: d.message, ts: ts0, source_uuid: randomUUID() },
    { kind: 'system', content: `Running Claude Code - ${words.toLocaleString('en-US')} words${wasLive ? ' (hot session)' : ''}`, ts: ts0, source_uuid: randomUUID() },
  );

  // Per-turn stream plumbing, same shapes as spawnGipityClaude's splitter.
  const phases = new PhaseTracker();
  const deltaAcc = new DeltaAccumulator(getRelaySecrets);
  const deltaBatcher = new DeltaBatcher((flush) => {
    void postStreamDelta(d.conversation_guid, d.short_guid, flush);
  });
  const toolNames = new Map<string, string>();
  const msgSeq = new Map<string, number>();
  let attached = false;
  let finalResult: IngestEntry | null = null;
  let contextTokens: number | undefined;
  const startedAt = Date.now();

  const buildProgress = (alive: boolean) => {
    const now = Date.now();
    const tool = phases.currentTool();
    const hint = tool?.hint ? redactString(tool.hint, getRelaySecrets()).slice(0, 200) : undefined;
    return {
      dispatch_guid: d.short_guid,
      proc_alive: alive,
      stdout_bytes_total: 0,
      stdout_bytes_delta: 0,
      stdout_idle_ms: Math.max(0, now - phases.lastEventAt),
      uptime_ms: Math.max(0, now - startedAt),
      phase: phases.phase,
      current_tool: tool?.name?.slice(0, 100),
      current_tool_hint: hint,
      tool_elapsed_ms: tool ? Math.max(0, now - tool.startedAt) : undefined,
      last_event_ms: Math.max(0, now - phases.lastEventAt),
      context_tokens: contextTokens,
    };
  };

  const onMessage = (msg: any): void => {
    phases.note(msg);
    const usageIn = msg?.message?.usage?.input_tokens;
    if (typeof usageIn === 'number' && usageIn > (contextTokens ?? 0)) contextTokens = usageIn;
    deltaBatcher.push(deltaAcc.note(msg));
    let entries = mapEventToEntries(msg, { toolNames, msgSeq });
    if (entries.length === 0) return;
    entries = entries.filter(e => {
      if (e.kind === 'attach') { if (attached) return false; attached = true; return true; }
      if (e.kind === 'result') { finalResult = e; return false; }
      return true;
    });
    if (entries.length === 0) return;
    const ts = new Date().toISOString();
    for (const e of entries) { e.ts = ts; if (!e.source_uuid) e.source_uuid = randomUUID(); }
    queue.push(...entries);
  };

  const env = childEnv({ GIPITY_CONVERSATION_GUID: d.conversation_guid, GIPITY_CAPTURE: 'off' });
  const freshOptions: Record<string, unknown> = {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: GIPITY_QUESTION_PROTOCOL },
    env,
    pathToClaudeCodeExecutable: resolveCommand('claude'),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(d.model ? { model: d.model } : {}),
  };

  poolDispatches.set(d.short_guid, d.conversation_guid);
  void postProgress(d.conversation_guid, buildProgress(true));
  const progressTimer = setInterval(() => {
    void postProgress(d.conversation_guid, buildProgress(true));
  }, 2000);
  progressTimer.unref?.();

  const t0 = Date.now();
  try {
    const result = await pool.runTurn({
      convGuid: d.conversation_guid,
      cwd,
      message,
      model: d.model,
      freshOptions,
      onMessage,
    });
    clearInterval(progressTimer);
    deltaBatcher.flush();
    if (finalResult) queue.push(finalResult);
    if (result.sessionId) recordSessionForConv(d.conversation_guid, result.sessionId);
    const dur = formatDuration(Date.now() - t0);
    void postProgress(d.conversation_guid, buildProgress(false));

    if (result.outcome === 'cancelled') {
      pushSystem(`Claude Code cancelled (${dur})`);
      await flushQueue();
      await ack(d.short_guid, 'cancelled');
    } else if (result.outcome === 'error') {
      pushSystem(`Claude Code failed (${dur}: ${result.error ?? 'session error'})`);
      await flushQueue();
      await ack(d.short_guid, 'error', `session pool: ${result.error ?? 'error'}`);
    } else {
      pushSystem(`Claude Code finished (${dur}${result.wasHot ? ', hot' : ''})`);
      await flushQueue();
      await ack(d.short_guid, 'done');
    }
    log('info', 'pool turn complete', { id: d.short_guid, outcome: result.outcome, hot: result.wasHot, ms: Date.now() - t0 });
    return true;
  } catch (err: any) {
    clearInterval(progressTimer);
    if (err instanceof PoolFullError) {
      // No idle session to evict - let the caller spawn a normal child. We
      // have NOT acked or pushed a marker beyond the prompt echo, so the
      // spawn path takes over cleanly.
      log('info', 'pool full - falling back to spawn for this dispatch', { id: d.short_guid });
      return false;
    }
    // A genuine pool error after the turn started: ack it here rather than
    // double-running via the spawn path (the turn may have partially executed).
    log('error', 'pool turn errored - acking error', { id: d.short_guid, err: err?.message });
    pushSystem(`Claude Code failed (session pool error: ${err?.message ?? 'unknown'})`);
    await flushQueue();
    await ack(d.short_guid, 'error', `session pool error: ${err?.message ?? 'unknown'}`);
    return true;
  } finally {
    poolDispatches.delete(d.short_guid);
  }
}

/**
 * Auto-resolve the cwd for a dispatched project. If `~/GipityProjects/<slug>/`
 * exists with a matching .gipity.json, use it. Otherwise create the dir,
 * write the config, install capture hooks, and pull project files - so the
 * user never has to pre-register a project. This replaces the old
 * per-project allowlist.
 */
async function resolveCwdForProject(d: ClaimedDispatch): Promise<{ cwd: string; bootstrapped: boolean }> {
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
      if (cfg.projectGuid === d.project_guid) return { cwd: path, bootstrapped: false };
      log('warn', 'project dir exists but guid mismatch - using it anyway', {
        path, expected: d.project_guid, found: cfg.projectGuid,
      });
      return { cwd: path, bootstrapped: false };
    } catch { /* fall through to re-bootstrap */ }
  }

  log('info', 'bootstrapping new project dir', { slug: d.project_slug, path });
  mkdirSync(path, { recursive: true });
  const apiBase = getApiBaseOverride() || DEFAULT_API_BASE;
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
  // helpers take cwd implicitly - run from the target path.
  const origCwd = process.cwd();
  try {
    process.chdir(path);
    setupProjectTools();
  } finally {
    process.chdir(origCwd);
  }
  // Sync is NOT done here: the dispatch handler runs it as an explicit, visible,
  // timeout-bounded step (a blocking in-process sync here used to hang the whole
  // dispatch with no timeout and no user feedback).
  return { cwd: path, bootstrapped: true };
}

/** Registry of live Claude children, keyed by dispatch short_guid. The
 *  cancellation poller SIGTERMs entries here when the server reports a
 *  matching dispatch has been user-cancelled. The kill-on-new-message
 *  path SIGTERMs entries matching an incoming dispatch's conv_guid.
 *
 *  `exited` resolves when the child's `exit` event fires (not when
 *  `killDispatch` is called). Callers that need to wait for cleanup -
 *  e.g. `killRunningForConv` before spawning a replacement - await it
 *  so the outgoing child has a chance to post its cancelled marker and
 *  ack before the new one starts. */
interface RunningEntry {
  child: ChildProcess;
  convGuid: string;
  exited: Promise<void>;
  /** Claude Code session id from the child's stream-json init event, once
   *  seen. Lets kill-on-new-message upgrade a stale `start` dispatch to a
   *  `--resume` of the session the killed child had already created. */
  sessionId?: string;
}
const running = new Map<string, RunningEntry>();

/** Last session id seen per conversation, TTL-bounded. Belt for the window
 *  where the server enqueued a `start` dispatch before the previous run's
 *  SessionStart reached it (claim-time derivation upstream shrinks that
 *  window to ingest lag; this map closes it locally, including the case
 *  where the previous child already exited so there's nothing to kill). */
const LAST_SESSION_TTL_MS = 10 * 60_000;
const lastSessionByConv = new Map<string, { sessionId: string; at: number }>();

function recordSessionForConv(convGuid: string, sessionId: string): void {
  const now = Date.now();
  for (const [k, v] of lastSessionByConv) {
    if (now - v.at > LAST_SESSION_TTL_MS) lastSessionByConv.delete(k);
  }
  lastSessionByConv.set(convGuid, { sessionId, at: now });
}

function lastSessionForConv(convGuid: string): string | null {
  const hit = lastSessionByConv.get(convGuid);
  if (!hit || Date.now() - hit.at > LAST_SESSION_TTL_MS) return null;
  return hit.sessionId;
}

// ─── Session pool wiring (Phase 2) ──────────────────────────────────────
// Pool dispatch guid → conv guid, so the cancellation poller can interrupt a
// live pool turn (which has no child process in `running`).
const poolDispatches = new Map<string, string>();
let sessionPool: SessionPool | undefined;

/** Real SDK-backed query factory. The SDK is loaded lazily so a daemon with
 *  the flag OFF never imports it. */
const realQueryFactory: QueryFactory = (params) => {
  const query = (globalThis as any).__gipitySdkQuery;
  if (!query) throw new Error('Agent SDK not loaded');
  return query(params);
};

async function getSessionPool(): Promise<SessionPool> {
  if (sessionPool) return sessionPool;
  if (!(globalThis as any).__gipitySdkQuery) {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    (globalThis as any).__gipitySdkQuery = mod.query;
  }
  sessionPool = new SessionPool({
    queryFactory: realQueryFactory,
    log,
    hotWindowMs: SESSION_HOT_MS,
    maxSessions: MAX_SESSIONS,
    onStateChange: () => pokeHeartbeat(),
  });
  return sessionPool;
}

// Immediate-heartbeat signal: session-state changes fire this so the web
// indicator flips hot/cold within a beat instead of waiting up to 60s.
let heartbeatPoke: (() => void) | null = null;
function pokeHeartbeat(): void { heartbeatPoke?.(); }

/** Snapshot of live pool sessions for the session-state heartbeat. */
export function getLiveSessionStates(): Array<{ convGuid: string; state: SessionStateKind }> {
  return sessionPool ? sessionPool.liveConversations() : [];
}

export function getRunningDispatchGuids(): string[] {
  return [...running.keys(), ...poolDispatches.keys()];
}

export function getRunningConvGuids(): string[] {
  return [...running.values()].map(e => e.convGuid);
}

/** SIGTERM any running child whose conv_guid matches, then wait for each
 *  to fully unwind (exit event fires, handleDispatch acks + posts
 *  cancelled marker). Used at the top of handleDispatch so a new message
 *  for a busy conv cleanly replaces the in-flight one. No-op if no child
 *  matches. */
/** Grace period between SIGTERM and the SIGKILL escalation. A child that traps
 *  or ignores SIGTERM (or is blocked in uninterruptible I/O) must not hang the
 *  handler forever - that would permanently hold one of the concurrency slots.
 *  Overridable for tests. */
const KILL_GRACE_MS = parseInt(process.env.GIPITY_RELAY_KILL_GRACE_MS || '10000', 10);

export async function killRunningForConv(convGuid: string): Promise<{ killedSessionIds: string[] }> {
  const matches = [...running.values()].filter(e => e.convGuid === convGuid);
  if (matches.length === 0) return { killedSessionIds: [] };
  for (const e of matches) {
    log('info', 'interrupting previous dispatch for conv', { conv: convGuid });
    try { e.child.kill('SIGTERM'); } catch { /* ignore - already exited */ }
  }
  // Wait for a clean unwind, but escalate to SIGKILL if the grace period
  // elapses so a stuck child can't wedge a slot. Whichever resolves first,
  // we still await `exited` so the outgoing children post their cancelled
  // markers + acks before the replacement spawns.
  const graceTimers: NodeJS.Timeout[] = [];
  const escalate = new Promise<void>(resolve => {
    const t = setTimeout(() => {
      for (const e of matches) {
        log('warn', 'previous dispatch ignored SIGTERM - escalating to SIGKILL', { conv: convGuid });
        try { e.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      resolve();
    }, KILL_GRACE_MS);
    graceTimers.push(t);
  });
  await Promise.race([Promise.all(matches.map(e => e.exited)), escalate]);
  // Ensure every child has actually exited (SIGKILL fires the exit event too).
  await Promise.all(matches.map(e => e.exited));
  for (const t of graceTimers) clearTimeout(t);
  return { killedSessionIds: matches.map(e => e.sessionId).filter((s): s is string => !!s) };
}

/** Spawn `gipity claude …` in `cwd` with `--output-format stream-json
 *  --verbose` so every event (assistant messages, tool_use blocks,
 *  tool_result blocks, result summary) lands on stdout as NDJSON. Each
 *  line is parsed and POSTed to `/ingest` - no hooks, no transcript
 *  file reads.
 *
 *  Returns `{ exitCode, killed }` where `killed` is true if we SIGTERMed
 *  the child (cancellation). Injectable via GIPITY_RELAY_CLAUDE_CMD env
 *  for tests. */
/** Spawn `gipity sync` in the project dir to reconcile any local writes
 *  back to VFS. Runs as a child so we inherit sync's cwd-walk for config
 *  resolution (the daemon itself doesn't chdir into projects).
 *  Non-blocking on failure - caller catches and logs. */
async function spawnSync(cwd: string, timeoutMs?: number, onSpawn?: (child: ChildProcess) => void): Promise<void> {
  // resolveCommand: on Windows the bare `gipity` is a .cmd shim that spawn
  // can't launch without an explicit path. An explicit env override is used
  // verbatim (it may be a full path); only the default name is resolved.
  const cmd = process.env.GIPITY_RELAY_CLAUDE_CMD || resolveCommand('gipity');
  return new Promise((resolve, reject) => {
    const child = spawnCommand(cmd, ['sync', '--json'], {
      cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Hand the child to the caller so it can register the sync in `running`,
    // making it cancellable (the poller / kill-on-new-message can SIGTERM it).
    onSpawn?.(child);
    // Drain pipes so the child doesn't stall on a full buffer.
    let stdoutLen = 0;
    let stderrBuf = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (fn: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(); };
    // A sync that never returns must not hang the dispatch forever. Kill the child
    // and clear its sync.lock (a SIGKILL'd `gipity sync` leaves the lock behind,
    // which would make the next sync wait 30s on a dead holder).
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        try { unlinkSync(join(cwd, '.gipity', 'sync.lock')); } catch { /* not there */ }
        finish(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
      }, timeoutMs);
    }
    child.stdout?.on('data', (b: Buffer) => { stdoutLen += b.length; });
    child.stderr?.on('data', (b: Buffer) => { stderrBuf += b.toString('utf-8'); });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', (code) => finish(() => {
      if (code === 0) {
        log('info', 'sync done', { cwd, stdoutLen });
        resolve();
      } else {
        reject(new Error(`gipity sync exited ${code}${stderrBuf ? `: ${stderrBuf.trim().slice(0, 300)}` : ''}`));
      }
    }));
  });
}

export async function spawnGipityClaude(
  args: string[],
  cwd: string,
  d: ClaimedDispatch,
  queue?: IngestQueue,
  meta?: { resumeWords?: number },
): Promise<{ exitCode: number; killed: boolean; runtimeLimit?: boolean; stderrTail?: string; startupMs?: number }> {
  // resolveCommand: on Windows the bare `gipity` is a .cmd shim that spawn
  // can't launch without an explicit path. An explicit env override is used
  // verbatim (it may be a full path); only the default name is resolved.
  const cmd = process.env.GIPITY_RELAY_CLAUDE_CMD || resolveCommand('gipity');
  // Inject stream-json flags here rather than at the call site so every
  // relay spawn path gets the same protocol. `--verbose` is required by
  // Claude Code when combining `-p` with `--output-format stream-json`.
  // `--include-partial-messages` adds stream_event token deltas, which
  // feed the ephemeral live-typing channel (see stream-delta.ts); whole
  // assistant/tool events still arrive unchanged for the persistent path.
  const fullArgs = [...args, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  // GIPITY_CAPTURE=off: the daemon owns capture for this dispatch (it
  // parses the stream-json on stdout), so the plugin's lifecycle-hook
  // capture must stand down. `gipity claude` sets the same sentinel on the
  // Claude child when it detects a daemon spawn; setting it here too keeps
  // dispatches double-post-free even across CLI version skew.
  const env = childEnv({ GIPITY_CONVERSATION_GUID: d.conversation_guid, GIPITY_CAPTURE: 'off' });

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawnCommand(cmd, fullArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    // `exited` fires when the child fully unwinds (exit event). Callers
    // like `killRunningForConv` await this before spawning a replacement
    // so the outgoing child has a chance to post its cancelled marker
    // and ack the dispatch.
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>(r => { resolveExited = r; });
    running.set(d.short_guid, { child, convGuid: d.conversation_guid, exited });

    // Ordered per-dispatch ingest queue. Entries flow through it in
    // arrival order with backoff retry - a transient network/server error
    // no longer drops stream content permanently (source_uuid dedup makes
    // the retries safe). Falls back to a local queue when the caller
    // didn't pass one (tests, direct invocation).
    const q = queue ?? (() => {
      const rw = new ImageBlockRewriter(
        d.conversation_guid,
        (msg, meta) => log('warn', msg, { id: d.short_guid, ...meta }),
      );
      rw.setCwd(cwd);
      return new IngestQueue(
        async (entries) => postIngest(d.conversation_guid, await rw.rewrite(entries)),
        { onWarn: (msg, meta) => log('warn', msg, { id: d.short_guid, ...meta }) },
      );
    })();
    const ownQueue = !queue;

    // Progress heartbeat state. Measured at the daemon boundary - this is
    // what we actually observe, not anything the child self-reports. These
    // fields are fully generic (no Claude Code-specific shape) so the same
    // payload works for a future codex/aider/etc. runner.
    const dispatchStartedAt = Date.now();
    let stdoutBytesTotal = 0;
    let lastStdoutByteAt = dispatchStartedAt;
    let stdoutBytesAtLastTick = 0;
    const phases = new PhaseTracker();

    // Rich-heartbeat state, updated from the stream: the agent's current
    // context size (latest input_tokens off a usage-bearing event) so the
    // client can show context-window fill. Machine stats are read fresh per
    // tick (os.* are in-memory kernel values - instant, no I/O).
    let contextTokens: number | undefined;
    let firstEventAt: number | undefined; // for the startup-latency metric
    const CPU_COUNT = cpus().length;
    const TOTAL_MEM = totalmem();

    const buildProgressPayload = (procAlive: boolean) => {
      const now = Date.now();
      const delta = stdoutBytesTotal - stdoutBytesAtLastTick;
      stdoutBytesAtLastTick = stdoutBytesTotal;
      const tool = phases.currentTool();
      // The hint (Bash command / file path / URL) comes straight from
      // tool input, so it can contain a secret the agent echoed - this
      // liveness channel must scrub it, exactly like the ingest and delta
      // channels do (it's the third path the same tool_use fans out to).
      // `current_tool` is clamped to the server's max(100) so a long MCP
      // tool name (`mcp__server__tool`) can't 400 every tick and starve
      // the client's liveness stream.
      const hint = tool?.hint ? redactString(tool.hint, getRelaySecrets()).slice(0, 200) : undefined;
      return {
        dispatch_guid: d.short_guid,
        proc_alive: procAlive,
        stdout_bytes_total: stdoutBytesTotal,
        stdout_bytes_delta: delta,
        stdout_idle_ms: Math.max(0, now - lastStdoutByteAt),
        uptime_ms: Math.max(0, now - dispatchStartedAt),
        phase: phases.phase,
        current_tool: tool?.name?.slice(0, 100),
        current_tool_hint: hint,
        tool_elapsed_ms: tool ? Math.max(0, now - tool.startedAt) : undefined,
        last_event_ms: Math.max(0, now - phases.lastEventAt),
        retry: phases.retry ?? undefined,
        // Rich heartbeat: real host + session telemetry.
        machine_load1: Math.round(loadavg()[0] * 100) / 100,
        machine_free_mem: freemem(),
        machine_total_mem: TOTAL_MEM,
        machine_cpus: CPU_COUNT,
        context_tokens: contextTokens,
        resume_words: meta?.resumeWords,
      };
    };

    // Immediate first tick: don't make the user stare at a static "Running
    // Claude Code" line for the first ~2s. Fire one heartbeat right away so
    // the spinner + machine/id readout appears the moment we spawn.
    void postProgress(d.conversation_guid, buildProgressPayload(true));
    const progressTimer = setInterval(() => {
      void postProgress(d.conversation_guid, buildProgressPayload(child.exitCode === null));
    }, 2000);

    // Max-runtime guard: a wedged child (hung tool, upstream stall) must
    // not tick `proc_alive:true` forever - after the limit, terminate it
    // with the same SIGTERM→SIGKILL escalation the cancel path uses and
    // surface a visible marker + error ack (via `runtimeLimit`).
    let runtimeLimit = false;
    const maxRuntimeMs = parseInt(process.env.GIPITY_RELAY_MAX_RUNTIME_MS || String(45 * 60_000), 10);
    const maxRuntimeTimer = maxRuntimeMs > 0 ? setTimeout(() => {
      runtimeLimit = true;
      log('warn', 'dispatch hit max runtime - terminating child', { id: d.short_guid, maxRuntimeMs });
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }, KILL_GRACE_MS).unref();
    }, maxRuntimeMs) : null;
    maxRuntimeTimer?.unref();

    // Stdout: NDJSON stream → parse → enqueue each event's ingest entries
    // as they arrive. That's the live-streaming path - every assistant
    // message and tool call appears in the web CLI within a second of
    // Claude emitting it.
    // Per-dispatch tool_use_id → tool_name map so a `tool_result` event can
    // be denormalized with its tool's name (the result block omits it);
    // msgSeq disambiguates per-block assistant events sharing a message id
    // (their source_uuid becomes `msg_x#0`, `msg_x#1`, …).
    const toolNames = new Map<string, string>();
    const msgSeq = new Map<string, number>();
    const unmapped = new Map<string, number>();
    // Token-delta pipeline: accumulate stream_event fragments, emit
    // redaction-safe spans, batch every 150ms/4KB to /stream-delta.
    const deltaAcc = new DeltaAccumulator(getRelaySecrets);
    const deltaBatcher = new DeltaBatcher((flush) => {
      void postStreamDelta(d.conversation_guid, d.short_guid, flush);
    });
    // A spawn with background subagents can emit several init and result
    // events (the loop re-invokes when a task completes). Attach once;
    // buffer results and post only the last (its cost is cumulative).
    let attached = false;
    let finalResult: IngestEntry | null = null;
    const splitter = createLineSplitter((line) => {
      const evt = parseEvent(line, (reason, snippet) => {
        log('warn', 'stream-json parse skipped line', { id: d.short_guid, reason, snippet });
      });
      if (!evt) return;
      phases.note(evt);
      // Startup-latency metric: the FIRST stream event means Claude Code has
      // finished the pre-spawn work (project sync + cold start + MCP connect)
      // and is now producing output. Time from dispatch start to here is what
      // the user waits through before anything happens - the thing we want to
      // track per-dispatch (see remote_dispatches.metrics).
      if (firstEventAt === undefined) firstEventAt = Date.now();
      // Track the agent's live context size for the heartbeat: an assistant
      // (or result) event's usage.input_tokens IS the context loaded for that
      // turn. Take the max seen so the readout doesn't jump around between
      // a small cache-read turn and the full-context turn.
      const usageIn = (evt as any)?.message?.usage?.input_tokens;
      if (typeof usageIn === 'number' && usageIn > (contextTokens ?? 0)) contextTokens = usageIn;
      deltaBatcher.push(deltaAcc.note(evt));
      let entries = mapEventToEntries(evt, {
        toolNames, msgSeq,
        onUnmapped: (type, subtype) => {
          const key = subtype ? `${type}/${subtype}` : type;
          unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
        },
      });
      if (entries.length === 0) return;
      entries = entries.filter(e => {
        if (e.kind === 'attach') {
          // Record the child's session id (init event) for kill-on-new-message
          // start→resume upgrades - on every attach, even deduped ones, since a
          // subagent respawn re-announces the same session.
          if (e.session_id && isSafeSessionId(e.session_id)) {
            const entry = running.get(d.short_guid);
            if (entry) entry.sessionId = e.session_id;
            recordSessionForConv(d.conversation_guid, e.session_id);
          }
          if (attached) return false;
          attached = true;
          return true;
        }
        if (e.kind === 'result') {
          finalResult = e;
          return false;
        }
        return true;
      });
      if (entries.length === 0) return;
      // Stamp the read time as the event-time hint (event_at). Stream-json
      // carries no per-event timestamp; the daemon reads events as Claude
      // emits them, so receipt time is a close, per-event proxy - far
      // better than the single flush-time created_at on the whole batch.
      const ts = new Date().toISOString();
      for (const e of entries) {
        e.ts = ts;
        // Every entry needs a dedup key so a queue re-POST after a partial
        // server success can't double-insert. assistant/tool_use already
        // carry one (msg_id#n / tool_use_id); compact and any future
        // keyless kind get a stable UUID here - stable because the daemon
        // maps each stream line exactly once and the queue retries the
        // same object (the stream path never re-maps, unlike a transcript
        // replay), so the same uuid reaches the server on every retry.
        if (!e.source_uuid) e.source_uuid = randomUUID();
      }
      q.push(...entries);
    });
    child.stdout?.on('data', (chunk) => {
      stdoutBytesTotal += chunk.length;
      lastStdoutByteAt = Date.now();
      splitter.push(chunk);
    });
    child.stdout?.on('end', () => splitter.flush());

    // Stderr: human-readable only (Claude's progress bars, errors).
    // Kept on the daemon's own stderr for `gipity relay log`, plus a
    // small tail ring so a crash with no stream output can include the
    // real error in the visible failure marker instead of just an exit
    // code. The readline interface is closed in the error/exit handler
    // so the listener doesn't outlive the child.
    const errPrefix = C.dim('│ ');
    const stderrTail: string[] = [];
    const errRl = child.stderr ? createInterface({ input: child.stderr }) : null;
    errRl?.on('line', (line) => {
      process.stderr.write(errPrefix + line + '\n');
      if (line.trim()) {
        stderrTail.push(line.trim());
        if (stderrTail.length > 3) stderrTail.shift();
      }
    });

    let killed = false;
    const cleanup = () => {
      clearInterval(progressTimer);
      running.delete(d.short_guid);
      errRl?.close();
      resolveExited();
    };
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    // Finalize on 'close', NOT 'exit': 'exit' fires when the process dies,
    // which can be BEFORE the last stdout chunks drain. Claude emits the
    // `result` footer (with cumulative cost) immediately before exiting,
    // so finalizing on 'exit' races that line - `finalResult` would be
    // parsed by the splitter's `'end'` flush AFTER we'd already resolved,
    // silently losing the session footer + cost. 'close' fires only once
    // all stdio is closed (after `'end'` → `splitter.flush()`), so every
    // event is mapped by the time we get here. Carries the same (code,
    // signal) as 'exit'.
    child.on('close', async (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') killed = true;
      // Post the buffered session footer now that we know it's final (a
      // spawn with background subagents emits several result events; the
      // last carries the cumulative cost).
      if (finalResult) {
        finalResult.ts = new Date().toISOString();
        finalResult.source_uuid = randomUUID();
        q.push(finalResult);
      }
      if (unmapped.size > 0) {
        log('info', 'unmapped stream events this dispatch', {
          id: d.short_guid,
          counts: Object.fromEntries(unmapped),
        });
      }
      if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
      deltaBatcher.close();
      // Final heartbeat with proc_alive:false so the web CLI's progress
      // line flips to Exited even if the 2s interval just missed the
      // exit (the interval is cleared in cleanup()).
      void postProgress(d.conversation_guid, buildProgressPayload(false));
      // Only drain here when we own the queue; otherwise handleDispatch
      // closes it after pushing its tail marker (order preserved).
      if (ownQueue) await q.close();
      cleanup();
      resolve({
        exitCode: code ?? 1, killed, runtimeLimit, stderrTail: stderrTail.join(' | '),
        startupMs: firstEventAt !== undefined ? Math.max(0, firstEventAt - dispatchStartedAt) : undefined,
      });
    });
  });
}

/** Run the pre-Claude `gipity sync` for a dispatch, registered in `running`
 *  so it's cancellable. Without this the dispatch is invisible to the
 *  cancellation poller and to kill-on-new-message during the sync, so a slow
 *  sync couldn't be interrupted for up to PROJECT_SYNC_TIMEOUT_MS. Returns
 *  `{ killed }` = true when the sync child was SIGTERMed externally (user
 *  cancel or a newer message on the same conv), distinct from a genuine sync
 *  failure (which throws) - the daemon's own timeout uses SIGKILL, so a
 *  SIGTERM here can only be an external interrupt. */
async function runDispatchSync(d: ClaimedDispatch, cwd: string): Promise<{ killed: boolean }> {
  let killed = false;
  try {
    await spawnSync(cwd, PROJECT_SYNC_TIMEOUT_MS, (child) => {
      const exited = new Promise<void>(resolve => {
        child.once('exit', (_code, signal) => {
          if (signal === 'SIGTERM') killed = true;
          resolve();
        });
      });
      running.set(d.short_guid, { child, convGuid: d.conversation_guid, exited });
    });
    return { killed: false };
  } catch (err) {
    if (killed) return { killed: true };
    throw err;
  } finally {
    running.delete(d.short_guid);
  }
}

/** Stop a specific running dispatch - SIGTERM its child (spawn path) or
 *  cleanly interrupt its live pool turn (session-pool path). Returns true if
 *  one was stopped, false if no such dispatch is running on this daemon. */
export function killDispatch(shortGuid: string): boolean {
  const entry = running.get(shortGuid);
  if (entry) {
    try { entry.child.kill('SIGTERM'); return true; } catch { return false; }
  }
  const convGuid = poolDispatches.get(shortGuid);
  if (convGuid && sessionPool) {
    void sessionPool.interrupt(convGuid);
    return true;
  }
  return false;
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

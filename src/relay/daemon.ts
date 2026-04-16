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
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

// Log path — `gipity relay log` tails this file.
export const RELAY_LOG_PATH = join(homedir(), '.gipity', 'relay.log');

// ─── Tunables ──────────────────────────────────────────────────────────
// Match the server hold (30s) plus a small cushion. Server may return 204
// slightly after its own deadline; we accept that. Values can be overridden
// by env for tests.
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.GIPITY_RELAY_HEARTBEAT_MS || '60000', 10);
const LONG_POLL_TIMEOUT_MS  = parseInt(process.env.GIPITY_RELAY_POLL_TIMEOUT_MS || '35000', 10);
const BACKOFF_BASE_MS       = parseInt(process.env.GIPITY_RELAY_BACKOFF_BASE_MS || '1000', 10);
const BACKOFF_MAX_MS        = parseInt(process.env.GIPITY_RELAY_BACKOFF_MAX_MS || '30000', 10);

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

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  if (level === 'debug' && !verboseMode) return;
  // Pretty line to stderr for the human watching `gipity relay run`.
  const pretty = `${C.dim(hhmmss())} ${badge(level)} ${C.bold(msg)}${formatExtra(extra)}`;
  process.stderr.write(pretty + '\n');
  // Full JSON mirrored to ~/.gipity/relay.log so `gipity relay log` and
  // any external log collector still see structured data.
  try {
    mkdirSync(join(homedir(), '.gipity'), { recursive: true });
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

  // Run both loops concurrently; exit when either returns (or abort fires).
  const stopCode = await Promise.race([
    heartbeatLoop(ctx),
    dispatchLoop(ctx, opts),
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
}

async function dispatchLoop(ctx: Ctx, opts: DaemonOptions): Promise<number> {
  let backoff = 0;
  while (!ctx.abort.signal.aborted) {
    if (opts.maxDispatches != null && ctx.dispatchesHandled >= opts.maxDispatches) {
      ctx.abort.abort('maxDispatches');
      return 0;
    }
    try {
      const r = await deviceFetch('GET', '/remote-devices/next', undefined, LONG_POLL_TIMEOUT_MS, ctx.abort.signal);
      if (r.status === 401) {
        log('warn', 'next 401 — device revoked, exiting clean');
        ctx.abort.abort('revoked');
        return 0;
      }
      if (r.status === 204) { backoff = 0; continue; }
      if (!r.ok) throw new Error(`next ${r.status}`);

      const json = await r.json() as { data: ClaimedDispatch };
      const d = json.data;
      if (!d || typeof d.short_guid !== 'string') {
        log('warn', 'claim returned unexpected shape', { json: json as unknown });
        backoff = 0;
        continue;
      }

      await handleDispatch(d);
      ctx.dispatchesHandled++;
      backoff = 0;
    } catch (err: any) {
      if (ctx.abort.signal.aborted) return 0;
      log('warn', 'dispatch-loop error', { err: err?.message });
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_BASE_MS);
      await sleep(backoff, ctx.abort.signal);
    }
  }
  return 0;
}

// ─── Per-dispatch handler ──────────────────────────────────────────────

/** Post a `role='system'` message into a conv via the capture-routes family.
 *  Device-authed (this daemon's token). Non-2xx is logged but never throws —
 *  a missing lifecycle marker is a cosmetic issue, not a dispatch failure. */
async function postSystem(convGuid: string, content: string): Promise<void> {
  try {
    const res = await deviceFetch('POST', `/remote-sessions/${encodeURIComponent(convGuid)}/system`, {
      content,
    }, 10_000);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('warn', 'system post non-2xx', { convGuid, httpStatus: res.status, body: body.slice(0, 200) });
    }
  } catch (err: any) {
    log('warn', 'system post network error', { convGuid, err: err?.message });
  }
}

/** 123 B / 4.2 KB / 1.3 MB — short + readable for the "Invoking…" badge. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

  // Lifecycle marker: "Invoking Claude Code …". Lands in the conv as a
  // role='system' message, visible live + on refresh. Tells the user
  // the relay received + started processing the dispatch even if Claude
  // is slow to respond.
  const words = d.message.trim().split(/\s+/).filter(Boolean).length;
  const bytes = Buffer.byteLength(d.message, 'utf-8');
  await postSystem(
    d.conversation_guid,
    `Invoking Claude Code (${words} word${words === 1 ? '' : 's'}, ${formatBytes(bytes)})`,
  );

  const t0 = Date.now();
  let exitCode = 1;
  let spawnErr: string | null = null;
  try {
    exitCode = await spawnGipityClaude(args, cwd, d.conversation_guid);
  } catch (err: any) {
    spawnErr = err?.message || String(err);
    log('error', 'dispatch spawn failed', { id: d.short_guid, err: spawnErr });
  }
  const ms = Date.now() - t0;
  const dur = formatDuration(ms);

  // Lifecycle marker: "Claude Code finished (…)" / "failed (…)". Runs
  // regardless of outcome so the user always sees a closing footer even
  // when the transcript hook's late POST hasn't landed yet.
  const tail = spawnErr
    ? `failed (${dur}: ${spawnErr})`
    : exitCode === 0
      ? `finished (${dur})`
      : `failed (${dur}, exit ${exitCode})`;
  await postSystem(d.conversation_guid, `Claude Code ${tail}`);

  if (spawnErr) {
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
    agentGuid: '',
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

/** Spawn `gipity claude …` in `cwd`. Inherits stdio so the child's
 *  stream-json flows to our stdout (which launchd/systemd captures).
 *  `GIPITY_CONVERSATION_GUID` is passed to the child so every capture
 *  hook tags events with the right conv. Injectable via
 *  GIPITY_RELAY_CLAUDE_CMD env for tests. */
export async function spawnGipityClaude(args: string[], cwd: string, convGuid: string): Promise<number> {
  const cmd = process.env.GIPITY_RELAY_CLAUDE_CMD || 'gipity';
  const env = { ...process.env, GIPITY_CONVERSATION_GUID: convGuid };
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = C.dim('│ ');
    const pipeLines = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WritableStream) => {
      if (!stream) return;
      const rl = createInterface({ input: stream });
      rl.on('line', line => sink.write(prefix + line + '\n'));
    };
    pipeLines(child.stdout, process.stdout);
    pipeLines(child.stderr, process.stderr);
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
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

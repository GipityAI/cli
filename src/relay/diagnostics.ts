/**
 * Relay diagnostics snapshot: non-PII host + version telemetry the daemon
 * reports on its heartbeat (once at startup, then ~daily). Sent as the
 * heartbeat body `{ diagnostics }` and stored on the server as
 * `remote_devices.diagnostics` (JSONB); the web client surfaces it in the
 * Relays table (versions inline, host specs on hover).
 *
 * Design rules:
 *   - EVERY probe is best-effort: a failure yields undefined/null for that
 *     field, never a thrown error. `collectDiagnostics()` always resolves.
 *   - NO personally-identifying data: no paths, no hostname, no username -
 *     only counts and non-identifying machine specs.
 *   - Cheap in-memory `os.*` reads are gathered inline; the costlier probes
 *     (agent `--version` subprocesses, GPU detection) are bounded with a short
 *     timeout and only run when the daemon refreshes the snapshot (startup +
 *     ~daily), never on the plain 60s liveness ping.
 *
 * Wire shape mirrors packages/shared `RelayDiagnostics` on the platform side.
 */
import { cpus, freemem, totalmem, loadavg, release, uptime, homedir } from 'os';
import { statfsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import { resolveCommand, spawnCommand } from '../platform.js';
import { cliVersion } from '../client-context.js';
import { AGENT_ADAPTERS } from '../agents/index.js';
import { claudeAuthStatusAsync } from '../claude-setup.js';

export interface RelayDiagnostics {
  collected_at?: string;
  gipity_version?: string;
  node_version?: string;
  os?: { platform?: string; release?: string; arch?: string };
  cpu?: { count?: number; model?: string };
  mem?: { total?: number; free?: number };
  load1?: number;
  uptime_s?: number;
  disk?: { total?: number; free?: number };
  gpu?: string | null;
  /** Keyed by the conversation `source` value ('claude_code', 'codex', …)
   *  plus the non-agent 'cursor' extra. */
  agents?: Record<string, string>;
  projects_local?: number;
  /** Whether Claude Code on this machine is signed in. A dispatch to a machine
   *  whose Claude Code is logged out fails on arrival, and until now that was
   *  only discoverable by sending a message and watching it fail - so report it
   *  on the heartbeat and let the UI warn first. `undefined` means the question
   *  couldn't be answered (Claude Code absent, or too old for `auth status`),
   *  which must not be rendered as "logged out". */
  claude_auth?: { logged_in: boolean; method?: string; subscription?: string };
}

const PROBE_TIMEOUT_MS = 4000;

/** Extract a semver-ish token from a `--version` line ("2.0.14 (Claude Code)"
 *  → "2.0.14"). Returns undefined when nothing version-like is present.
 *  Exported for unit tests. */
export function parseVersion(out: string): string | undefined {
  const m = out.match(/\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?/);
  return m ? m[0] : undefined;
}

/**
 * Run a command and capture stdout, ASYNC + non-blocking with a hard timeout.
 * This must not be `spawnSync`: `collectDiagnostics()` runs inside the daemon's
 * heartbeat loop, which shares one event loop with the dispatch + cancellation
 * loops - a synchronous spawn would freeze all of them for the probe's
 * duration. Resolves '' on spawn error, timeout (child SIGKILL'd), or non-zero
 * exit with no output; never rejects.
 */
function runProbe(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (s: string) => { if (!settled) { settled = true; resolve(s); } };
    let child: ChildProcess;
    try {
      child = spawnCommand(resolveCommand(cmd), args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return done('');
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(out); }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); done(''); });
    child.on('close', () => { clearTimeout(timer); done(out); });
  });
}

/** Run `<cmd> --version` (bounded, best-effort). undefined if the command is
 *  absent, errors, or prints nothing version-like. */
async function probeVersion(cmd: string): Promise<string | undefined> {
  return parseVersion(await runProbe(cmd, ['--version']));
}

/** Best-effort GPU description. Short-timeout, platform-specific, null on any
 *  failure - never blocks the snapshot. */
async function detectGpu(): Promise<string | null> {
  if (process.platform === 'darwin') {
    const m = (await runProbe('system_profiler', ['SPDisplaysDataType'])).match(/Chipset Model:\s*(.+)/);
    return m ? m[1].trim() : null;
  }
  if (process.platform === 'linux') {
    // nvidia-smi is fast + precise when present; fall back to lspci.
    const nvName = (await runProbe('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])).split('\n')[0]?.trim();
    if (nvName) return nvName;
    const line = (await runProbe('sh', ['-c', "lspci | grep -iE 'vga|3d|display'"])).split('\n')[0]?.trim();
    if (!line) return null;
    // Strip the "00:02.0 VGA compatible controller: " prefix.
    const after = line.split(/:\s/).slice(2).join(': ').trim();
    return after || line;
  }
  if (process.platform === 'win32') {
    const line = (await runProbe('wmic', ['path', 'win32_VideoController', 'get', 'name']))
      .split('\n').map(l => l.trim()).filter(l => l && l !== 'Name')[0];
    return line ?? null;
  }
  return null;
}

/** Free/total bytes on the projects volume (best-effort). */
function diskUsage(): { total?: number; free?: number } | undefined {
  try {
    if (typeof statfsSync !== 'function') return undefined;
    const st = statfsSync(join(homedir(), 'GipityProjects'), { bigint: false }) as
      | { bsize: number; blocks: number; bavail: number }
      | undefined;
    if (!st || !st.bsize) return undefined;
    return { total: st.bsize * st.blocks, free: st.bsize * st.bavail };
  } catch {
    // Projects dir may not exist yet - try the home volume instead.
    try {
      const st = statfsSync(homedir(), { bigint: false }) as { bsize: number; blocks: number; bavail: number };
      return { total: st.bsize * st.blocks, free: st.bsize * st.bavail };
    } catch {
      return undefined;
    }
  }
}

/** Count of directories under ~/GipityProjects (no names). */
function localProjectCount(): number | undefined {
  try {
    return readdirSync(join(homedir(), 'GipityProjects'), { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch {
    return undefined;
  }
}

/**
 * Gather the full snapshot. Cheap `os.*` reads plus the bounded subprocess
 * probes. Always resolves (best-effort per field).
 */
export async function collectDiagnostics(): Promise<RelayDiagnostics> {
  const cores = (() => { try { return cpus(); } catch { return []; } })();
  // Run the subprocess probes concurrently (each already bounded + best-effort)
  // so the whole snapshot costs one timeout, not the sum of four. `cursor` is
  // a non-agent extra (no adapter - it's not a coding agent Gipity dispatches
  // to), probed alongside the registry-driven agent binaries.
  // claudeAuthStatusAsync is a local credential read (not billed) and is
  // already bounded + best-effort, so it joins the same concurrent batch.
  // Deliberately NOT recording the account email it also returns: this payload
  // is non-PII by design.
  const [versions, cursor, gpu, claudeAuth] = await Promise.all([
    Promise.all(AGENT_ADAPTERS.map((a) => probeVersion(a.binary))),
    probeVersion('cursor'),
    detectGpu(),
    claudeAuthStatusAsync(),
  ]);
  const agents: RelayDiagnostics['agents'] = {};
  AGENT_ADAPTERS.forEach((a, i) => {
    const v = versions[i];
    if (v) agents[a.source] = v;
  });
  if (cursor) agents.cursor = cursor;

  return {
    collected_at: new Date().toISOString(),
    gipity_version: cliVersion(),
    node_version: process.versions.node,
    os: { platform: process.platform, release: safe(() => release()), arch: process.arch },
    cpu: { count: cores.length || undefined, model: cores[0]?.model?.trim() || undefined },
    mem: { total: safe(() => totalmem()), free: safe(() => freemem()) },
    load1: safe(() => Math.round(loadavg()[0] * 100) / 100),
    uptime_s: safe(() => Math.round(uptime())),
    disk: diskUsage(),
    gpu,
    agents: Object.keys(agents).length ? agents : undefined,
    projects_local: localProjectCount(),
    claude_auth: claudeAuth
      ? { logged_in: claudeAuth.loggedIn, method: claudeAuth.authMethod, subscription: claudeAuth.subscriptionType }
      : undefined,
  };
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

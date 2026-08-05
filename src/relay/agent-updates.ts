/**
 * Daily harness auto-update for the relay daemon.
 *
 * Relays run headless forever, and headless `-p` dispatches never trigger an
 * agent's own interactive auto-updater, so paired machines drift stale (the
 * relay installs Claude Code once via `npm install -g` and nothing ever
 * upgrades it). On the daemon's daily maintenance tick (same cadence as the
 * diagnostics snapshot) every agent adapter that declares an `updatePlan()`
 * is brought to the latest release, guarded so this can never disturb live
 * work:
 *
 *   - a pass starts only when no dispatches are in flight, and the dispatch
 *     loop holds off claiming new work while one runs ({@link
 *     agentUpdateInProgress}) - a binary is never swapped under a spawn
 *   - npm plans pre-check the registry and skip the spawn when already
 *     current (npm re-installs even at the same version)
 *   - every step is bounded by a hard timeout and best-effort: a failure
 *     logs and leaves the existing install untouched
 *   - off switches: `gipity relay updates off`, GIPITY_RELAY_AGENT_UPDATES=off,
 *     DISABLE_AUTOUPDATER=1 (see state.agentUpdatesEnabled - checked by the
 *     daemon before calling here)
 *
 * Upgrades are visible in `gipity relay log` (this module's log lines) and
 * server-side: after an actual upgrade the daemon refreshes its diagnostics
 * snapshot immediately, and the heartbeat route logs the version change.
 */
import type { ChildProcess } from 'child_process';
import type { AgentUpdatePlan, RemoteAgentAdapter } from '../agents/types.js';
import { AGENT_ADAPTERS } from '../agents/index.js';
import { parseVersion } from './diagnostics.js';
import { compareSemver } from '../updater/check.js';
import { resolveCommand, spawnCommand } from '../platform.js';

const UPDATE_TIMEOUT_MS = parseInt(process.env.GIPITY_RELAY_AGENT_UPDATE_TIMEOUT_MS || String(5 * 60_000), 10);
const PROBE_TIMEOUT_MS = 4000;
const REGISTRY_TIMEOUT_MS = 10_000;

export type UpdateLog = (level: 'info' | 'warn' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

export interface AgentUpdateResult {
  source: string;
  status: 'updated' | 'current' | 'failed' | 'skipped';
  from?: string;
  to?: string;
  detail?: string;
}

/** Injectable seams for tests - production callers pass nothing. */
export interface AgentUpdateDeps {
  adapters?: RemoteAgentAdapter[];
  exec?: (argv: string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;
  probeVersion?: (binary: string) => Promise<string | undefined>;
  fetchLatest?: (pkg: string) => Promise<string | null>;
}

// Test seam (mirrors GIPITY_RELAY_CLAUDE_CMD): when set, the pass updates ONE
// synthetic agent whose binary is this script (it must answer `--version` and
// `update`) instead of the real adapter registry, so the daemon integration
// test exercises the full tick → pass → probe → exec → re-probe → log path
// without ever touching a real install.
const UPDATE_STUB = process.env.GIPITY_RELAY_AGENT_UPDATE_STUB;
function stubAdapters(stub: string): RemoteAgentAdapter[] {
  return [{
    source: 'stub_agent',
    binary: stub,
    updatePlan: () => ({ argv: [stub, 'update'], label: 'stub' }),
  } as unknown as RemoteAgentAdapter];
}

// Cross-loop flag: the dispatch loop consults this before claiming work so a
// dispatch is never spawned mid-binary-swap. Module-level is safe - the
// daemon's pid lock guarantees one daemon per machine, and the heartbeat
// loop starts at most one pass at a time.
let inProgress = false;
export function agentUpdateInProgress(): boolean {
  return inProgress;
}

/** Run argv (no shell) capturing stdout+stderr, bounded by a hard timeout
 *  and the daemon's abort signal. Resolves, never rejects. */
function execCapture(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve({ ok, output }); } };
    let child: ChildProcess;
    try {
      child = spawnCommand(resolveCommand(argv[0]), argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      output = err?.message ?? 'spawn failed';
      return done(false);
    }
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { output += '\n[timed out]'; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); output += `\n${err.message}`; done(false); });
    child.on('close', (code) => { clearTimeout(timer); done(code === 0); });
  });
}

async function defaultProbeVersion(binary: string): Promise<string | undefined> {
  const r = await execCapture([binary, '--version'], PROBE_TIMEOUT_MS);
  return parseVersion(r.output);
}

/** Latest published version of an npm package, or null on any failure
 *  (offline, registry down) - the caller then defers to the next daily tick
 *  rather than blind-running npm. */
async function defaultFetchLatest(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json() as { version?: string };
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

const tail = (s: string) => s.trim().slice(-300).replace(/\s+/g, ' ');

/**
 * One update pass over all adapters. `busy` is re-checked before each agent
 * so a dispatch that slipped in mid-pass defers the remaining updates to the
 * next tick instead of racing it.
 */
export async function runAgentUpdates(
  opts: { log: UpdateLog; busy?: () => boolean; signal?: AbortSignal },
  deps: AgentUpdateDeps = {},
): Promise<AgentUpdateResult[]> {
  const adapters = deps.adapters ?? (UPDATE_STUB ? stubAdapters(UPDATE_STUB) : AGENT_ADAPTERS);
  const exec = deps.exec ?? execCapture;
  const probe = deps.probeVersion ?? defaultProbeVersion;
  const fetchLatest = deps.fetchLatest ?? defaultFetchLatest;
  const results: AgentUpdateResult[] = [];

  inProgress = true;
  try {
    for (const adapter of adapters) {
      const source = adapter.source;
      if (opts.signal?.aborted) { results.push({ source, status: 'skipped', detail: 'daemon shutting down' }); continue; }
      let plan: AgentUpdatePlan | null | undefined;
      try { plan = adapter.updatePlan?.(); } catch { plan = null; }
      if (!plan) { results.push({ source, status: 'skipped', detail: 'no unattended update path' }); continue; }
      if (opts.busy?.()) { results.push({ source, status: 'skipped', detail: 'dispatch in flight' }); continue; }

      const before = await probe(adapter.binary);
      // npm plans: skip the (slow, churny) install when the registry says
      // we're already at latest. Registry unreachable = defer, don't guess.
      if (plan.pkg && before) {
        const latest = await fetchLatest(plan.pkg);
        if (!latest) { results.push({ source, status: 'skipped', from: before, detail: 'registry check failed' }); continue; }
        if (compareSemver(latest, before) <= 0) {
          results.push({ source, status: 'current', from: before });
          opts.log('debug', `agent up-to-date: ${source} ${before}`);
          continue;
        }
      }

      opts.log('info', `agent update starting: ${source} via ${plan.label}`, { from: before ?? 'unknown' });
      const res = await exec(plan.argv, UPDATE_TIMEOUT_MS, opts.signal);
      const after = await probe(adapter.binary);
      if (!res.ok) {
        results.push({ source, status: 'failed', from: before, to: after, detail: tail(res.output) });
        opts.log('warn', `agent update failed: ${source}`, { detail: tail(res.output) });
      } else if (after && after !== before) {
        results.push({ source, status: 'updated', from: before, to: after });
        opts.log('info', `agent updated: ${source} ${before ?? 'unknown'} -> ${after}`);
      } else {
        // Exit 0 with an unchanged version: the agent's own self-updater
        // decided it was current (e.g. `claude update` no-op).
        results.push({ source, status: 'current', from: before, to: after });
        opts.log('debug', `agent up-to-date: ${source} ${after ?? 'unknown'}`);
      }
    }
  } finally {
    inProgress = false;
  }
  return results;
}

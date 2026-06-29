/**
 * Headless relay setup primitives — the non-interactive core shared by:
 *   - the first-run `gipity claude` onboarding (`onboarding.ts`),
 *   - the `gipity relay setup` command (installer/GUI entry point),
 *   - `gipity relay install` / `gipity relay autostart` (`relay-install.ts`).
 *
 * Keeping pairing + autostart here means a supervising app (e.g. the desktop
 * onboarding client) can drive the whole relay through one code path —
 * `pairDevice()` → `startDaemon()` / `installAutostart()` — without replaying
 * the interactive prompts that live in `onboarding.ts`. No `console` output
 * and no `process.exit` in this module: callers own all UX.
 */
import { spawn, spawnSync } from 'child_process';
import { hostname, platform as osPlatform } from 'os';
import { resolve, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { post } from '../api.js';
import * as state from './state.js';
import { planFor, type InstallerPlan } from './installers.js';
import { getMachineId } from './machine-id.js';

/** Normalize Node's `os.platform()` to what the backend accepts. */
export function mapPlatform(p: string): 'darwin' | 'linux' | 'win32' {
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
}

/** Absolute path to the currently-running `gipity` CLI. Embedded in service
 *  units so launchd/systemd/Task Scheduler re-launch the same binary even if
 *  PATH changes. */
export function resolveCliPath(): string {
  return resolve(process.argv[1] ?? 'gipity');
}

export interface PairedDevice {
  guid: string;
  name: string;
  platform: 'darwin' | 'linux' | 'win32';
  /** True when an existing pairing was returned untouched (no new device
   *  created), so callers can stay idempotent across repeated runs. */
  reused: boolean;
}

/**
 * Create + persist a relay device, marking the relay opted-in. Idempotent
 * unless `force`: if this machine is already paired and `!force`, the
 * existing device is returned untouched (no server call). With `force`, the
 * old device is revoked server-side (best-effort) before re-pairing.
 *
 * Throws on a bad name or if the `/remote-devices` call fails (e.g. 401 when
 * the user isn't logged in) — callers translate that into their own UX.
 */
export async function pairDevice(opts: { name?: string; force?: boolean } = {}): Promise<PairedDevice> {
  const existing = state.getDevice();
  if (existing && !opts.force) {
    state.setRelayEnabled(true);
    return {
      guid: existing.guid,
      name: existing.name,
      platform: mapPlatform(existing.platform),
      reused: true,
    };
  }
  if (existing && opts.force) {
    try {
      await post(`/remote-devices/${encodeURIComponent(existing.guid)}/revoke`, {});
    } catch {
      // Best-effort: a stale server-side device is harmless; proceed to re-pair.
    }
    state.clearDevice();
  }

  const name = (opts.name?.trim() || hostname() || 'my-pc').trim();
  if (!name || name.length > 100) {
    throw new Error('Device name must be 1–100 non-whitespace characters.');
  }
  const plat = mapPlatform(osPlatform());
  const res = await post<{
    data: { short_guid: string; name: string; platform: string; token: string };
  }>('/remote-devices', { name, platform: plat, machine_id: getMachineId() });

  state.setDevice({
    guid: res.data.short_guid,
    name,
    platform: plat,
    token: res.data.token,
    paired_at: new Date().toISOString(),
  });
  state.setRelayEnabled(true);
  return { guid: res.data.short_guid, name, platform: plat, reused: false };
}

/**
 * Spawn a fresh `gipity relay run` detached from this process. No-op if the
 * daemon is already running. Fire-and-forget — best-effort, never throws.
 *
 * Launches via the current Node binary + CLI entry script (not a shell): the
 * previous `shell: true` on Windows ran the `.js` path through Windows Script
 * Host instead of Node. `process.execPath` is cross-platform and needs no shell.
 */
export function startDaemon(): void {
  if (state.isDaemonRunning()) return;
  try {
    const child = spawn(process.execPath, [resolveCliPath(), 'relay', 'run'], {
      detached: true,
      stdio: 'ignore',
    });
    // A spawn 'error' arrives asynchronously and bypasses the try/catch; swallow
    // it so a launch failure stays best-effort instead of crashing the process.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

export interface AutostartResult {
  /** True if every service-manager command exited 0. The unit file is written
   *  regardless of this flag. */
  ok: boolean;
  /** Human-readable description of what the unit does. */
  summary: string;
  /** Where the unit file was written. */
  path: string;
}

/**
 * Write the platform service-unit and enable it (start at OS login,
 * auto-restart on crash). Throws `UnsupportedPlatformError` from `planFor` on
 * an OS we don't generate a unit for. Returns `ok: false` if a service-manager
 * command exits non-zero (the file is still written, so the caller can point
 * the user at a manual retry).
 *
 * `stdio` defaults to `'ignore'` (silent, for headless/GUI callers); the
 * interactive `relay install` passes `'inherit'` so the user sees
 * launchctl/systemctl/schtasks output verbatim.
 */
export function installAutostart(opts: { stdio?: 'ignore' | 'inherit' } = {}): AutostartResult {
  const stdio = opts.stdio ?? 'ignore';
  const plan = planFor({ cliPath: resolveCliPath() });
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.content);
  let ok = true;
  for (const argv of plan.enableCmds) {
    const r = spawnSync(argv[0], argv.slice(1), { stdio });
    if (r.status !== 0) { ok = false; break; }
  }
  return { ok, summary: plan.summary, path: plan.path };
}

/**
 * Best-effort removal of the OS autostart unit. Disable is not fail-fast (the
 * service may already be stopped); we run every command and report whether all
 * succeeded. Throws `UnsupportedPlatformError` on an unsupported OS.
 */
export function removeAutostart(opts: { stdio?: 'ignore' | 'inherit' } = {}): { ok: boolean; plan: InstallerPlan } {
  const stdio = opts.stdio ?? 'ignore';
  const plan = planFor({ cliPath: resolveCliPath() });
  let ok = true;
  for (const argv of plan.disableCmds) {
    const r = spawnSync(argv[0], argv.slice(1), { stdio });
    if (r.status !== 0) ok = false;
  }
  return { ok, plan };
}

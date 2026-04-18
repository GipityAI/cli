/**
 * `gipity uninstall` — true reset. Stops the relay daemon, removes the
 * platform autostart service, revokes the device on the server (best-effort),
 * and wipes ~/.gipity/. Optionally wipes ~/GipityProjects/ on request.
 *
 * Does not touch the npm-installed shim — the user removes that separately
 * via `npm uninstall -g gipity`.
 */
import { Command } from 'commander';
import { existsSync, rmSync, unlinkSync } from 'fs';
import { homedir, platform as osPlatform } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { post } from '../api.js';
import { getAuth } from '../auth.js';
import { confirm, getAutoConfirm } from '../utils.js';
import { bold, brand, dim, success, error as clrError, muted } from '../colors.js';
import * as relayState from '../relay/state.js';
import { planFor, UnsupportedPlatformError } from '../relay/installers.js';

function resolveCliPath(): string {
  return resolve(process.argv[1] ?? 'gipity');
}

async function stopDaemon(): Promise<void> {
  if (!relayState.isDaemonRunning()) return;
  const pidPath = relayState.getDaemonPidPath();
  let pid: number | null = null;
  try {
    const raw = (await import('fs')).readFileSync(pidPath, 'utf-8').trim();
    pid = parseInt(raw, 10) || null;
  } catch { /* ignore */ }
  if (!pid) return;

  try { process.kill(pid, 'SIGTERM'); } catch { /* may have died already */ }

  // Poll for up to ~3s.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!relayState.isDaemonRunning()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  // Last resort.
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function removeServiceUnit(): { ran: boolean; ok: boolean; note?: string } {
  try {
    const plan = planFor({ cliPath: resolveCliPath() });
    // Run the disable sequence directly — no shell, so paths with spaces /
    // shell metacharacters can't break out. Best-effort: a non-zero exit
    // is fine if the service was never installed.
    let allOk = true;
    for (const argv of plan.disableCmds) {
      const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' });
      if (r.status !== 0) allOk = false;
    }
    if (existsSync(plan.path)) {
      try { unlinkSync(plan.path); } catch { /* ignore */ }
    }
    return { ran: true, ok: allOk, note: plan.summary };
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) return { ran: false, ok: true, note: `Unsupported platform (${process.platform}) — nothing to uninstall.` };
    return { ran: false, ok: false, note: String(err) };
  }
}

async function revokeDeviceBestEffort(): Promise<void> {
  const device = relayState.loadState().device;
  if (!device) return;
  if (!getAuth()) return; // not logged in → can't call authenticated endpoint
  try {
    await post(`/remote-devices/${encodeURIComponent(device.guid)}/revoke`, {});
  } catch {
    // Swallow — we still want the local wipe to succeed.
  }
}

export const uninstallCommand = new Command('uninstall')
  .description('Stop the relay, remove autostart, revoke the device, and wipe ~/.gipity/')
  .option('--yes', 'Skip confirmation prompts')
  .option('--purge-projects', 'Also delete ~/GipityProjects/ (your local project trees)')
  .action(async (opts: { yes?: boolean; purgeProjects?: boolean }) => {
    const autoYes = opts.yes || getAutoConfirm();
    const gipityDir = join(homedir(), '.gipity');
    const projectsDir = join(homedir(), 'GipityProjects');

    console.log('');
    console.log(`  ${bold('Gipity uninstall')} — this will:`);
    console.log(`    • Stop the running relay daemon (if any)`);
    console.log(`    • Remove the OS autostart service (launchd / systemd / Task Scheduler)`);
    console.log(`    • Revoke this device on the server (best-effort)`);
    console.log(`    • Delete ${gipityDir}/`);
    console.log('');
    console.log(`  ${dim('It will NOT remove the `gipity` binary. Run `npm uninstall -g gipity` afterward if you want that too.')}`);
    console.log('');

    if (!autoYes) {
      const ok = await confirm('  Proceed?');
      if (!ok) {
        console.log(`  ${muted('Cancelled.')}`);
        return;
      }
    }

    // 1. Stop daemon.
    await stopDaemon();
    console.log(`  ${success('Daemon stopped.')}`);

    // 2. Remove OS service.
    const svc = removeServiceUnit();
    if (svc.ran && svc.ok) console.log(`  ${success('Autostart service removed.')} ${svc.note ? dim(`(${svc.note})`) : ''}`);
    else if (svc.ran) console.log(`  ${muted('Autostart service not installed or already gone.')}`);
    else console.log(`  ${muted(svc.note ?? 'Autostart skipped.')}`);

    // 3. Revoke device on server.
    await revokeDeviceBestEffort();
    console.log(`  ${success('Device revoked on server (or was already revoked).')}`);

    // 4. Wipe ~/.gipity/.
    if (existsSync(gipityDir)) {
      try {
        rmSync(gipityDir, { recursive: true, force: true });
        console.log(`  ${success(`Removed ${gipityDir}/`)}`);
      } catch (err: any) {
        console.error(`  ${clrError(`Could not remove ${gipityDir}: ${err?.message || err}`)}`);
      }
    } else {
      console.log(`  ${muted(`${gipityDir}/ already gone.`)}`);
    }

    // 5. Offer to wipe ~/GipityProjects/.
    if (existsSync(projectsDir)) {
      let alsoPurge = opts.purgeProjects === true;
      if (!alsoPurge && !autoYes) {
        alsoPurge = await confirm(`  Also delete ${projectsDir}/ (your local project trees)?`);
      }
      if (alsoPurge) {
        try {
          rmSync(projectsDir, { recursive: true, force: true });
          console.log(`  ${success(`Removed ${projectsDir}/`)}`);
        } catch (err: any) {
          console.error(`  ${clrError(`Could not remove ${projectsDir}: ${err?.message || err}`)}`);
        }
      } else {
        console.log(`  ${muted(`Kept ${projectsDir}/ (projects still live in the cloud).`)}`);
      }
    }

    console.log('');
    console.log(`  ${success('Uninstall complete.')} ${dim('Run')} ${brand('npm uninstall -g gipity')} ${dim('to remove the binary too.')}`);
    console.log('');
  });

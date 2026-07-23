/**
 * `gipity uninstall` - true reset. Stops the relay daemon, removes the
 * platform autostart service, revokes the device on the server (best-effort),
 * removes the Gipity Claude Code plugin enablement (which removes all Gipity
 * hooks at once), and wipes ~/.gipity/. Never touches ~/GipityProjects/ -
 * your local project trees are yours to keep or remove yourself.
 *
 * Does not touch the npm-installed shim - the user removes that separately
 * via `npm uninstall -g gipity`.
 */
import { Command } from 'commander';
import { existsSync, rmSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform as osPlatform } from 'os';
import { join, resolve } from 'path';
import { spawnSyncCommand, resolveCommand } from '../platform.js';
import { post } from '../api.js';
import { getAuth } from '../auth.js';
import { confirm, getAutoConfirm } from '../utils.js';
import { bold, brand, dim, success, error as clrError, muted } from '../colors.js';
import * as relayState from '../relay/state.js';
import { planFor, UnsupportedPlatformError } from '../relay/installers.js';
import {
  GIPITY_PLUGIN_ID, GIPITY_MARKETPLACE_NAME, stripGipityHooks, grokInstallState,
  agentSkillsState, AGENTS_SKILLS_DIR, agySkillsState, AGY_SKILLS_DIR,
} from '../setup.js';

/** Remove Gipity's entries from the user-scope Claude Code settings: the
 *  plugin enablement, the marketplace registration, and any legacy hook
 *  blocks older CLI versions wrote there. Surgical - everything else in the
 *  file (the user's own permissions, hooks, other plugins) is untouched. */
function removeGipityPluginConfig(): boolean {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;
  let settings: Record<string, any>;
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { return false; }

  let changed = stripGipityHooks(settings);
  if (settings.enabledPlugins && GIPITY_PLUGIN_ID in settings.enabledPlugins) {
    delete settings.enabledPlugins[GIPITY_PLUGIN_ID];
    if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
    changed = true;
  }
  if (settings.extraKnownMarketplaces?.[GIPITY_MARKETPLACE_NAME]) {
    delete settings.extraKnownMarketplaces[GIPITY_MARKETPLACE_NAME];
    if (Object.keys(settings.extraKnownMarketplaces).length === 0) delete settings.extraKnownMarketplaces;
    changed = true;
  }
  if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

/** The install.sh / install.ps1 launcher appends a line to the user's shell rc
 *  files putting ~/.gipity/launcher/bin on PATH. Once ~/.gipity is deleted that
 *  line points at nothing, so strip it back out - matched by the installer's own
 *  marker comment and the launcher bin path. Unix shells only; on Windows the
 *  installer edits the user PATH env var, which we leave untouched. Returns the
 *  rc files we actually changed. */
function removeInstallerPathLines(): string[] {
  if (osPlatform() === 'win32') return [];
  const marker = '# Added by the Gipity installer';
  const touched: string[] = [];
  for (const name of ['.bashrc', '.zshrc', '.profile']) {
    const rc = join(homedir(), name);
    if (!existsSync(rc)) continue;
    let text: string;
    try { text = readFileSync(rc, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    const kept = lines.filter(
      (line) => line.trim() !== marker && !line.includes('.gipity/launcher/bin'),
    );
    if (kept.length === lines.length) continue;
    try { writeFileSync(rc, kept.join('\n')); touched.push(rc); } catch { /* ignore */ }
  }
  return touched;
}

/** Render an absolute path under $HOME back to ~ for display. */
function tildify(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

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
    // Run the disable sequence directly - no shell, so paths with spaces /
    // shell metacharacters can't break out. Best-effort: a non-zero exit
    // is fine if the service was never installed.
    let allOk = true;
    for (const argv of plan.disableCmds) {
      const r = spawnSyncCommand(argv[0], argv.slice(1), { stdio: 'ignore' });
      if (r.status !== 0) allOk = false;
    }
    if (existsSync(plan.path)) {
      try { unlinkSync(plan.path); } catch { /* ignore */ }
    }
    return { ran: true, ok: allOk, note: plan.summary };
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) return { ran: false, ok: true, note: `Unsupported platform (${process.platform}) - nothing to uninstall.` };
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
    // Swallow - we still want the local wipe to succeed.
  }
}

export const uninstallCommand = new Command('uninstall')
  .description('Uninstall Gipity')
  .option('--yes', 'Skip confirmation prompts')
  .action(async (opts: { yes?: boolean }) => {
    const autoYes = opts.yes || getAutoConfirm();
    const gipityDir = join(homedir(), '.gipity');
    // Installs from install.sh / install.ps1 keep the launcher binary itself
    // under ~/.gipity/launcher/bin, so wiping ~/.gipity removes the binary too -
    // the only leftover is the PATH line the installer added to the shell rc
    // files (cleaned up below). An npm-global install instead leaves the binary
    // in npm's bin dir, which the user removes with `npm uninstall -g gipity`.
    const launcherBin = join(gipityDir, 'launcher', 'bin', 'gipity');
    const installedViaLauncher = existsSync(launcherBin);

    console.log(`${bold('Gipity uninstall')} - this will:`);
    console.log(`• Stop the running relay daemon (if any)`);
    console.log(`• Remove the OS autostart service (launchd / systemd / Task Scheduler)`);
    console.log(`• Revoke this device on the server (best-effort)`);
    console.log(`• Remove the Gipity Claude Code plugin enablement (all Gipity hooks)`);
    console.log(`• Delete ${gipityDir}/${installedViaLauncher ? dim(' (includes the gipity launcher binary itself)') : ''}`);
    if (installedViaLauncher) console.log(`• Remove the launcher PATH line from your shell startup files`);
    console.log('');
    if (installedViaLauncher) {
      console.log(`${dim('The `gipity` launcher lives under ~/.gipity, so this removes the binary too - no separate `npm uninstall` needed.')}`);
    } else {
      console.log(`${dim('It will NOT remove the `gipity` binary. Run `npm uninstall -g gipity` afterward if you want that too.')}`);
    }
    console.log('');

    if (!autoYes) {
      const ok = await confirm('Proceed?');
      if (!ok) {
        console.log(`${muted('Cancelled.')}`);
        return;
      }
    }

    // 1. Stop daemon.
    await stopDaemon();
    console.log(`${success('Daemon stopped.')}`);

    // 2. Remove OS service.
    const svc = removeServiceUnit();
    if (svc.ran && svc.ok) console.log(`${success('Autostart service removed.')} ${svc.note ? dim(`(${svc.note})`) : ''}`);
    else if (svc.ran) console.log(`${muted('Autostart service not installed or already gone.')}`);
    else console.log(`${muted(svc.note ?? 'Autostart skipped.')}`);

    // 3. Revoke device on server.
    await revokeDeviceBestEffort();
    console.log(`${success('Device revoked on server (or was already revoked).')}`);

    // 4. Remove the Claude Code plugin enablement + any legacy hook blocks.
    if (removeGipityPluginConfig()) {
      console.log(`${success('Gipity Claude Code plugin disabled (hooks removed).')}`);
    } else {
      console.log(`${muted('No Gipity entries in Claude Code settings.')}`);
    }

    // 4b. Uninstall the Gipity plugin from Grok Build and remove the skills
    //     the CLI copied into the cross-agent ~/.agents/skills dir for Codex.
    //     Both best-effort: neither existing is the common case.
    if (grokInstallState().exists) {
      spawnSyncCommand(resolveCommand('grok'), ['plugin', 'uninstall', 'gipity', '--confirm'], {
        stdio: 'ignore',
        timeout: 60_000,
      });
      console.log(`${success('Gipity plugin removed from Grok.')}`);
    }
    const agentSkills = agentSkillsState();
    if (agentSkills.skills.length) {
      for (const name of agentSkills.skills) {
        // Only names our manifest recorded - never someone else's skills.
        try { rmSync(join(AGENTS_SKILLS_DIR, name), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      console.log(`${success(`Removed ${agentSkills.skills.length} Gipity skills from ~/.agents/skills.`)}`);
    }

    // 4c. Remove the skills the CLI copied into Antigravity's own global
    //     skill root (~/.gemini/config/skills - a different directory from
    //     Codex's ~/.agents/skills, see setup.ts).
    const agySkills = agySkillsState();
    if (agySkills.skills.length) {
      for (const name of agySkills.skills) {
        try { rmSync(join(AGY_SKILLS_DIR, name), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      console.log(`${success(`Removed ${agySkills.skills.length} Gipity skills from ~/.gemini/config/skills.`)}`);
    }

    // 5. Wipe ~/.gipity/ (this also removes the agent-hooks scripts and the
    //    agent-skills manifest, which live under it).
    if (existsSync(gipityDir)) {
      try {
        rmSync(gipityDir, { recursive: true, force: true });
        console.log(`${success(`Removed ${gipityDir}/`)}`);
      } catch (err: any) {
        console.error(`${clrError(`Could not remove ${gipityDir}: ${err?.message || err}`)}`);
      }
    } else {
      console.log(`${muted(`${gipityDir}/ already gone.`)}`);
    }

    // 6. Strip the launcher PATH line the installer added to shell rc files, so
    //    we don't leave a dangling entry pointing at the dir we just deleted.
    const touchedRc = removeInstallerPathLines();
    if (touchedRc.length) {
      console.log(`${success('Removed the launcher PATH line from')} ${dim(touchedRc.map(tildify).join(', '))}`);
    }

    console.log('');
    console.log(`${success('Uninstall complete.')}`);
    if (installedViaLauncher) {
      console.log(`${dim('The launcher binary was under ~/.gipity and is now gone - nothing left to remove.')}`);
    } else {
      console.log(`${dim('Run')} ${brand('npm uninstall -g gipity')} ${dim('to remove the `gipity` binary too.')}`);
    }
    // The current shell caches the removed binary's path in its command hash, so
    // the next `gipity` here reports "No such file or directory" until it's
    // cleared. A new terminal always fixes it; `hash -r` fixes this one.
    console.log(`${dim('Open a new terminal - or run')} ${brand('hash -r')} ${dim('in this one - so your shell forgets the removed binary’s path.')}`);
  });

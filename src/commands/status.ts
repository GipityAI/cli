import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { getAuth, getTimeRemaining } from '../auth.js';
import { getConfig } from '../config.js';
import { brand, success, warning, muted, error as clrError } from '../colors.js';
import { HOOKS_SETTINGS, setupClaudeHooks } from '../setup.js';

/** Inspect `.claude/settings.json` against the current `HOOKS_SETTINGS`.
 *  Returns the set of hook-event names that are missing or mismatched. */
function checkCaptureHooks(cwd: string): { missing: string[]; ok: boolean } {
  const path = join(cwd, '.claude', 'settings.json');
  if (!existsSync(path)) return { missing: Object.keys(HOOKS_SETTINGS.hooks), ok: false };

  let settings: any;
  try { settings = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return { missing: Object.keys(HOOKS_SETTINGS.hooks), ok: false }; }

  const actualHooks = settings?.hooks ?? {};
  const missing: string[] = [];
  for (const [event, expectedGroups] of Object.entries(HOOKS_SETTINGS.hooks)) {
    const actualGroups: any[] = Array.isArray(actualHooks[event]) ? actualHooks[event] : [];
    const expectedCmds = new Set(
      (expectedGroups as any[]).flatMap(g => (g.hooks ?? []).map((h: any) => h.command)),
    );
    const actualCmds = new Set(
      actualGroups.flatMap(g => (g.hooks ?? []).map((h: any) => h.command)),
    );
    // Every expected command must be present. Users can add their own.
    for (const cmd of expectedCmds) {
      if (!actualCmds.has(cmd)) { missing.push(event); break; }
    }
  }
  return { missing, ok: missing.length === 0 };
}

export const statusCommand = new Command('status')
  .description('Show project and auth status, check Claude Code capture hooks')
  .option('--json', 'Output as JSON')
  .option('--repair-hooks', 'Reinstall the capture hooks in .claude/settings.json if missing')
  .action(async (opts) => {
    const config = getConfig();
    const auth = getAuth();
    const cwd = resolve(process.cwd());
    const hookCheck = config ? checkCaptureHooks(cwd) : null;

    if (opts.json) {
      console.log(JSON.stringify({
        project: config ? {
          guid: config.projectGuid,
          slug: config.projectSlug,
          account: config.accountSlug,
          apiBase: config.apiBase,
        } : null,
        auth: auth ? {
          email: auth.email,
          expiresAt: auth.expiresAt,
          valid: new Date(auth.expiresAt).getTime() > Date.now(),
        } : null,
        capture_hooks: hookCheck,
      }, null, 2));
      return;
    }

    if (!config) {
      console.log(warning('Not a Gipity project. Run: gipity init'));
    } else {
      console.log(`${muted('Project:')} ${brand(config.projectSlug)} ${muted(`(${config.projectGuid})`)}`);
      console.log(`${muted('Account:')} ${config.accountSlug}`);
      console.log(`${muted('API:')} ${config.apiBase}`);
      if (config.agentGuid) console.log(`${muted('Agent:')} ${config.agentGuid}`);
    }

    if (!auth) {
      console.log(`${muted('Auth:')} ${warning('not logged in. Run: gipity login')}`);
    } else {
      console.log(`${muted('Auth:')} ${success(auth.email)} ${muted(`(${getTimeRemaining()})`)}`);
    }

    if (hookCheck) {
      if (hookCheck.ok) {
        console.log(`${muted('Hooks:')}   ${success('capture hooks installed')}`);
      } else if (opts.repairHooks) {
        setupClaudeHooks();
        console.log(`${muted('Hooks:')}   ${success('repaired — re-installed capture hooks')}`);
      } else {
        console.log(`${muted('Hooks:')}   ${warning(`missing/modified: ${hookCheck.missing.join(', ')}`)}`);
        console.log(`         ${muted('Run `gipity status --repair-hooks` to re-install.')}`);
        console.log(`         ${muted('Without these, web CLI dispatches can\'t show Claude Code output.')}`);
      }
    }
  });

void clrError; // kept for future error paths

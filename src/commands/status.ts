import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { getAuth, getTimeRemaining } from '../auth.js';
import { getConfig, liveUrl } from '../config.js';
import { brand, success, warning, muted, error as clrError } from '../colors.js';
import { GIPITY_PLUGIN_ID, GIPITY_MARKETPLACE_NAME, setupClaudeHooks, ensureGipityPlugin } from '../setup.js';

/** Hooks ship in the Gipity Claude Code plugin now - "installed" means the
 *  user-scope settings register the marketplace and enable the plugin.
 *  Claude Code fetches/updates the plugin itself at launch. */
function checkGipityPlugin(): { missing: string[]; ok: boolean } {
  const path = join(homedir(), '.claude', 'settings.json');
  let settings: any = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* treat as empty */ }
  }
  const missing: string[] = [];
  if (!settings?.extraKnownMarketplaces?.[GIPITY_MARKETPLACE_NAME]) missing.push('marketplace');
  if (settings?.enabledPlugins?.[GIPITY_PLUGIN_ID] !== true) missing.push('plugin');
  return { missing, ok: missing.length === 0 };
}

export const statusCommand = new Command('status')
  .description('Show project and login status')
  .option('--json', 'Output as JSON')
  .option('--repair-hooks', 'Re-enable the Gipity Claude Code plugin (hooks) if missing or disabled')
  .action(async (opts) => {
    const config = getConfig();
    const auth = getAuth();
    const cwd = resolve(process.cwd());
    void cwd;
    const hookCheck = config ? checkGipityPlugin() : null;

    if (opts.json) {
      console.log(JSON.stringify({
        project: config ? {
          guid: config.projectGuid,
          slug: config.projectSlug,
          account: config.accountSlug,
          apiBase: config.apiBase,
          url: liveUrl(config),
        } : null,
        auth: auth ? {
          email: auth.email,
          expiresAt: auth.expiresAt,
          valid: new Date(auth.expiresAt).getTime() > Date.now(),
        } : null,
        plugin: hookCheck,
      }, null, 2));
      return;
    }

    if (!config) {
      console.log(warning('Not a Gipity project. Run: gipity init'));
    } else {
      console.log(`${muted('Project:')} ${brand(config.projectSlug)} ${muted(`(${config.projectGuid})`)}`);
      console.log(`${muted('Account:')} ${config.accountSlug}`);
      console.log(`${muted('Live:')} ${liveUrl(config)}`);
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
        console.log(`${muted('Hooks:')}   ${success(`Gipity plugin enabled (${GIPITY_PLUGIN_ID})`)}`);
      } else if (opts.repairHooks) {
        // force: an explicit repair request overrides a previous disable.
        ensureGipityPlugin(true);
        setupClaudeHooks();
        console.log(`${muted('Hooks:')}   ${success('repaired - Gipity plugin re-enabled')}`);
      } else {
        console.log(`${muted('Hooks:')}   ${warning(`Gipity plugin not enabled (missing: ${hookCheck.missing.join(', ')})`)}`);
        console.log(muted('Run `gipity status --repair-hooks` to re-enable.'));
        console.log(muted('Without it, files don\'t auto-sync and web CLI dispatches can\'t show Claude Code output.'));
      }
    }
  });

void clrError; // kept for future error paths

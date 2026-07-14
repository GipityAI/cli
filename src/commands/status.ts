import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { getAuth, sessionExpired } from '../auth.js';
import { get, usingEnvToken, ApiError } from '../api.js';
import { getConfig, liveUrl } from '../config.js';
import { brand, success, warning, muted, error as clrError } from '../colors.js';
import { GIPITY_PLUGIN_ID, GIPITY_MARKETPLACE_NAME, setupClaudeHooks, ensureGipityPlugin, ensureGipityPluginInstalled, userScopeInstallState } from '../setup.js';
import { flushBugQueue } from '../bug-queue.js';

/** Hooks ship in the Gipity Claude Code plugin now. "Installed" means three
 *  things must all hold: the user-scope settings register the marketplace and
 *  enable the plugin (declarative), AND Claude Code actually has a user-scope
 *  install of the current version on disk. The last check matters because
 *  CC >=2.1.x does not materialize a user-scope install from enablement alone -
 *  without it the hooks never load and capture/file-sync silently die, so
 *  reporting "ok" on the declarative keys alone would be a false green. */
function checkGipityPlugin(): { missing: string[]; ok: boolean; stale: boolean } {
  const path = join(homedir(), '.claude', 'settings.json');
  let settings: any = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* treat as empty */ }
  }
  const missing: string[] = [];
  if (!settings?.extraKnownMarketplaces?.[GIPITY_MARKETPLACE_NAME]) missing.push('marketplace');
  if (settings?.enabledPlugins?.[GIPITY_PLUGIN_ID] !== true) missing.push('plugin');
  const install = userScopeInstallState();
  if (!install.current) missing.push('install');
  // "stale" = declaratively enabled AND a user-scope install exists; it's just
  // behind the version this CLI needs. The hooks still LOAD (at the old
  // version), so this is a version-lag update, not a dead plugin - don't warn
  // as if files aren't syncing at all. Only true when `install` is the sole gap.
  const stale = missing.length === 1 && missing[0] === 'install' && install.exists;
  return { missing, ok: missing.length === 0, stale };
}

/** What one live authenticated call says about the session/token right now.
 *  Local expiry alone can lie: a refresh token rotated away by a sibling
 *  process or revoked server-side still decodes as "fresh", and `status` is
 *  the command agents run to diagnose exactly that 401 (cli#137).
 *  - 'ok'          the call succeeded (the 401 self-heal counts as success)
 *  - 'rejected'    the server 401'd even after the refresh-and-retry
 *  - 'unreachable' network/timeout - nothing proven either way
 *  - 'expired'     locally known-dead refresh token (no call made)
 *  - 'none'        not logged in and no GIPITY_TOKEN (no call made) */
type AuthProbe = 'ok' | 'rejected' | 'unreachable' | 'expired' | 'none';

async function probeAuth(loggedIn: boolean): Promise<AuthProbe> {
  if (!loggedIn && !usingEnvToken()) return 'none';
  if (!usingEnvToken() && sessionExpired()) return 'expired';
  // Cap the probe well below the API layer's 60s request timeout - status is
  // a diagnostic command and must answer fast even when the network is dark.
  const timeout = new Promise<'unreachable'>(res => setTimeout(() => res('unreachable'), 5000).unref?.());
  const call = get('/users/me').then(
    () => 'ok' as const,
    (err) => (err instanceof ApiError && err.statusCode === 401 ? 'rejected' as const : 'unreachable' as const),
  );
  return Promise.race([call, timeout]);
}

// `whoami` is the name agents reach for first when they want the signed-in
// identity (it's the unix spelling), and this is the command that prints it.
// Aliasing costs one line and turns a guess into a hit.
export const statusCommand = new Command('status')
  .alias('whoami')
  .description('Show project and login status')
  .option('--json', 'Output as JSON')
  .option('--repair-hooks', 'Re-enable the Gipity Claude Code plugin (hooks) if missing or disabled')
  .action(async (opts) => {
    const config = getConfig();
    const auth = getAuth();
    const cwd = resolve(process.cwd());
    void cwd;
    const hookCheck = config ? checkGipityPlugin() : null;

    // `status` is the command an agent reaches for to confirm "are we back?"
    // after an outage/session-expiry - a valid, unexpired session here is the
    // clearest signal we have that any bug reports stranded by that outage can
    // now go out. Skipped entirely (existsSync short-circuit) when the queue
    // is empty, which is the common case, so this stays a no-op most runs.
    const queueDelivered = (auth && !sessionExpired()) ? await flushBugQueue().catch(() => 0) : 0;
    const probe = await probeAuth(!!auth);

    if (opts.json) {
      console.log(JSON.stringify({
        project: config ? {
          guid: config.projectGuid,
          slug: config.projectSlug,
          account: config.accountSlug,
          apiBase: config.apiBase,
          url: liveUrl(config),
        } : null,
        // `valid` reflects the refresh token (the real session) - access
        // tokens auto-renew, so their expiry must not read as "invalid".
        // `probe` is what one live call just proved: 'rejected' means every
        // authenticated command will fail even though `valid` reads true.
        auth: (auth || usingEnvToken()) ? {
          email: auth?.email,
          source: usingEnvToken() ? 'agent-token' : 'session',
          valid: usingEnvToken() ? probe !== 'rejected' : !sessionExpired(),
          probe,
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

    if (usingEnvToken()) {
      console.log(`${muted('Auth:')} ${probe === 'rejected'
        ? warning('agent API token (GIPITY_TOKEN) rejected by the server — mint a new one: gipity skill read agent-deploy')
        : success('agent API token (GIPITY_TOKEN)')}${probe === 'unreachable' ? ` ${muted('(unverified — API unreachable)')}` : ''}`);
    } else if (!auth) {
      console.log(`${muted('Auth:')} ${warning('not logged in. Run: gipity login')}`);
    } else if (probe === 'expired') {
      console.log(`${muted('Auth:')} ${warning(`session expired for ${auth.email}. Run: gipity login (headless/CI: set GIPITY_TOKEN — gipity skill read agent-deploy)`)}`);
    } else if (probe === 'rejected') {
      // Locally fresh but the server says no (refresh token rotated away or
      // revoked). Without the live probe this printed a green identity while
      // every authenticated command failed.
      console.log(`${muted('Auth:')} ${warning(`session for ${auth.email} was rejected by the server. Run: gipity login (headless/CI: set GIPITY_TOKEN — gipity skill read agent-deploy)`)}`);
    } else {
      console.log(`${muted('Auth:')} ${success(auth.email)}${probe === 'unreachable' ? ` ${muted('(unverified — API unreachable)')}` : ''}`);
    }

    if (queueDelivered > 0) {
      console.log(`${muted('Bug queue:')} ${success(`delivered ${queueDelivered} queued bug report${queueDelivered === 1 ? '' : 's'}`)}`);
    }

    if (hookCheck) {
      if (hookCheck.ok) {
        console.log(`${muted('Hooks:')}   ${success(`Gipity plugin enabled (${GIPITY_PLUGIN_ID})`)}`);
      } else if (opts.repairHooks) {
        // force: an explicit repair request overrides a previous disable.
        ensureGipityPlugin(true);
        setupClaudeHooks();
        // Re-enabling the declarative keys isn't enough on CC >=2.1.x - also
        // materialize (or update) the user-scope install so the hooks load.
        ensureGipityPluginInstalled();
        // Re-check rather than claim success blindly: a stale user-scope
        // install only advances via `plugin update`, and if `claude` is off
        // PATH nothing changed at all - reporting "repaired" then would be a
        // lie the next `gipity status` immediately contradicts.
        const after = checkGipityPlugin();
        if (after.ok) {
          console.log(`${muted('Hooks:')}   ${success('repaired - Gipity plugin enabled')}`);
        } else {
          console.log(`${muted('Hooks:')}   ${warning(`repair incomplete (still missing: ${after.missing.join(', ')})`)}`);
          console.log(muted('Ensure `claude` is on PATH, then re-run. Restart Claude Code to load the update.'));
        }
      } else if (hookCheck.stale) {
        console.log(`${muted('Hooks:')}   ${warning('Gipity plugin out of date (an update is available)')}`);
        console.log(muted('Hooks still load, but run `gipity status --repair-hooks` to update to the latest.'));
      } else {
        console.log(`${muted('Hooks:')}   ${warning(`Gipity plugin not enabled (missing: ${hookCheck.missing.join(', ')})`)}`);
        console.log(muted('Run `gipity status --repair-hooks` to enable.'));
        console.log(muted('Without it, files don\'t auto-sync and web CLI dispatches can\'t show Claude Code output.'));
      }
    }
  });

void clrError; // kept for future error paths

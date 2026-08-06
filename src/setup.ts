/**
 * Shared project setup helpers used by both `init` and `claude`.
 */
import { resolve, join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, cpSync, readdirSync } from 'fs';
import { resolveCommand, spawnSyncCommand } from './platform.js';
import { SKILLS_CONTENT, BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE } from './knowledge.js';
import { DEFAULT_API_BASE, resolveApiBase } from './config.js';
import { ensureOpencodePluginInstalled } from './opencode-setup.js';

export { SKILLS_CONTENT };

/** Canonical list of workstation artifacts that are NOT part of the project.
 *  Used as the single source of truth for three separate decisions:
 *    1. Cloud sync - these files/globs are excluded from push and pull.
 *    2. CLI file count (`listProjectFiles` in commands/claude.ts) - these don't
 *       count toward "is this project empty?" for scaffold-gate and empty-state
 *       prompt decisions.
 *    3. Scaffold collision check - these can never collide with a scaffold
 *       because they're already skipped by sync and by the empty check.
 *
 *  Mental model: a file in this list is a client-side artifact, not project
 *  content. `CLAUDE.md` is generated fresh per-session from `SKILLS_CONTENT`
 *  in knowledge.ts and is CLI-version-dependent - syncing it would churn on
 *  every CLI upgrade. `.gipity.json`, `.gipity/`, and `.claude/` are per-
 *  workstation configuration. */
/** Relative path of each per-tool primer file we generate. Single source of
 *  truth: both {@link DEFAULT_SYNC_IGNORE} and the `setup*Md` writers read from
 *  here, so adding a tool can't silently leak its primer into project sync.
 *  Every primer is a CLI-version-generated client-side artifact (regenerated
 *  from knowledge.ts each session), not project content - syncing one churns on
 *  every CLI upgrade, so all of them are sync-ignored. */
export const PRIMER_FILES = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  grok: 'AGENTS.md', // Grok Build reads the AGENTS.md family (and CLAUDE.md) natively
  agy: 'AGENTS.md', // Antigravity reads the same AGENTS.md/GEMINI.md rules family natively
  opencode: 'AGENTS.md', // opencode reads AGENTS.md (and CLAUDE.md) natively
  aider: 'AGENTS.md', // shares the Codex primer; aider is pointed at it via .aider.conf.yml
  gemini: 'GEMINI.md',
  copilot: '.github/copilot-instructions.md',
  cursor: '.cursor/rules/gipity.mdc',
} as const;

/** Aider's config file. We write/merge a `read:` entry into it so aider loads
 *  AGENTS.md - a per-workstation artifact like the primers, never synced. */
export const AIDER_CONF_FILE = '.aider.conf.yml';

/** Project-local scratch namespaces: file conversions, intermediate outputs,
 *  design staging - work the agent wants on disk but should never sync or
 *  deploy. These MUST mirror the sandbox's `isEphemeralSandboxPath` denylist
 *  (`platform/server/src/services/sandbox/no-persist.ts`) so the same dirs are
 *  treated as throwaway everywhere: a sandbox run refuses to persist them, and
 *  `gipity sync`/deploy refuses to upload them. Keeping the two in lockstep is
 *  what makes scratch coherent across the platform - update both together.
 *  `tmp/` is the one we teach agents to use (see knowledge.ts "Files and sync");
 *  `*_tmp/` and `.gipityscratch/` are caught defensively so legacy/scattered
 *  scratch (the `_vsd_tmp/`/`_convert_tmp/` dirs that bloated past deploys)
 *  can't leak in either. Reference material to KEEP (diagrams, decks, ADRs) goes
 *  in `docs/` instead - synced and versioned, but outside `src/` so it's never
 *  deployed. Build screenshots follow the same keep-but-don't-deploy pattern in
 *  `screenshots/` (page-screenshot.ts writes there; the server excludes both
 *  dirs from root deploys in s3-deploy.ts). Gitignore-glob form, matched by the
 *  `ignore` package in config.ts. */
export const SCRATCH_IGNORE = ['tmp/', '.tmp/', '*_tmp/', '.gipityscratch/'];

export const DEFAULT_SYNC_IGNORE = [
  'node_modules', '.git', '.gipity.json', '.gipity/', '.claude/', '.codex/', '.agents/', '.gitignore', AIDER_CONF_FILE,
  // Home-directory junk: a project created inside a real home dir (or one that
  // shells out) sweeps in a cache dir + shell dotfiles that are never app
  // files. `.cache/` alone can be gigabytes (it was 2.4 GB on one project),
  // and reconciling it stalls every relay dispatch's pre-spawn sync.
  '.cache/', '.bash_history', '.bash_logout',
  ...SCRATCH_IGNORE,
  ...new Set(Object.values(PRIMER_FILES)),
];

/** True if `name` (a top-level dir entry) is a workstation artifact that
 *  should be excluded from sync, file counts, and collision checks.
 *  Matches exact names, trailing-slash dir patterns, and dotfiles generally. */
export function isSyncIgnored(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (DEFAULT_SYNC_IGNORE.includes(name)) return true;
  if (DEFAULT_SYNC_IGNORE.includes(`${name}/`)) return true;
  return false;
}



// Permissions: auto-allow safe gipity commands in Claude Code
// Destructive commands (db drop, deploy prod, email, file rm/restore/rollback) are excluded
export const PERMISSIONS_SETTINGS = {
  permissions: {
    allow: [
      'Bash(gipity status *)',
      'Bash(gipity sync *)',
      'Bash(gipity push *)',
      'Bash(gipity test *)',
      'Bash(gipity add *)',
      'Bash(gipity deploy dev *)',
      'Bash(gipity domain *)',
      'Bash(gipity db query *)',
      'Bash(gipity db list *)',
      'Bash(gipity db create *)',
      'Bash(gipity memory *)',
      'Bash(gipity page *)',
      'Bash(gipity logs *)',
      'Bash(gipity sandbox *)',
      'Bash(gipity chat *)',
      'Bash(gipity skill *)',
      'Bash(gipity credits *)',
      'Bash(gipity file ls *)',
      'Bash(gipity file cat *)',
      'Bash(gipity file tree *)',
      'Bash(gipity file versions *)',
      'Bash(gipity records *)',
      'Bash(gipity fn *)',
      'Bash(gipity service *)',
      'Bash(gipity rbac *)',
      'Bash(gipity audit *)',
      'Bash(gipity generate *)',
      'Bash(gipity location *)',
      'Bash(gipity workflow *)',
      'Bash(gipity agent *)',
      'Bash(gipity project *)',
      'Bash(gipity login *)',
    ],
  },
};

// Hooks now ship in the Gipity Claude Code plugin (GipityAI/skills,
// which doubles as its own marketplace): file sync (push on edit, pull on
// prompt) and `gipity claude` session capture, every script guarded to no-op
// outside Gipity projects. Past CLI versions wrote these hook blocks directly
// into each project's .claude/settings.json with absolute paths baked in -
// that left orphaned entries behind on uninstall (the CLI keeps no inventory
// of projects it touched) and could even land in the user-global settings
// when a gipity command ran from $HOME. The plugin replaces all of it: Claude
// Code resolves script paths via ${CLAUDE_PLUGIN_ROOT} and uninstall/disable
// removes every hook at once.
//
// Two steps are needed to make it load, split by testability and cost:
//   - ensureGipityPlugin()          - declarative: register the marketplace +
//     enable the plugin in ~/.claude/settings.json. Pure file writes.
//   - ensureGipityPluginInstalled() - imperative: actually install the plugin
//     at USER scope via the `claude plugin` CLI. Required because CC >=2.1.x no
//     longer materializes a user-scope install from enablement alone; without
//     it the hooks load only inside whatever project happened to install the
//     plugin (often nowhere), silently taking capture + file-sync down.
export const GIPITY_PLUGIN_ID = 'gipity@gipity';
export const GIPITY_MARKETPLACE_NAME = 'gipity';
export const GIPITY_MARKETPLACE_REPO = 'GipityAI/skills';
// Pre-rename name of the skills repo. GitHub redirects it, but settings
// written by older CLIs carry it verbatim - ensureGipityPlugin() migrates
// those so nothing keeps depending on the redirect.
export const LEGACY_MARKETPLACE_REPO = 'GipityAI/claude-plugin';

// The plugin version this CLI requires. Bump in lockstep with
// the skills repo's .claude-plugin/plugin.json: Claude Code does NOT auto-upgrade
// an installed plugin when the marketplace advances - only an explicit
// `plugin install`/`update` does - so this constant is how a CLI upgrade tells
// ensureGipityPluginInstalled() to refresh a stale user-scope install.
export const GIPITY_PLUGIN_VERSION = '0.7.0';

/** True for hook commands the CLI itself wrote into settings.json in past
 *  versions. Matched by signature so migration strips exactly our own
 *  entries and never touches user-authored hooks. */
export function isGipityManagedHookCommand(command: string): boolean {
  return (
    // Capture hooks: bare absolute runner path or the fire-time launcher.
    command.includes('capture-runner.js') ||
    // File-sync push one-liner (spawn('gipity',['push',p,'--quiet'],...)).
    command.includes("'gipity',['push'") ||
    // Pull-on-prompt one-liner, current and older variants.
    command.includes('gipity sync --json') ||
    command.includes('gipity sync down --json') ||
    // Scaffold nudge (retired entirely - CLAUDE.md carries the rule).
    command.includes("['gipity.yaml','src','functions','package.json']")
  );
}

/** Remove Gipity-managed hook entries from a parsed settings object,
 *  preserving user-authored hooks untouched. Returns true if anything
 *  was removed. Exported for tests and uninstall. */
export function stripGipityHooks(settings: Record<string, any>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group: any) => {
        if (!Array.isArray(group?.hooks)) return group;
        const remaining = group.hooks.filter(
          (h: any) => !(typeof h?.command === 'string' && isGipityManagedHookCommand(h.command)),
        );
        if (remaining.length !== group.hooks.length) changed = true;
        return { ...group, hooks: remaining };
      })
      .filter((group: any) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return changed;
}

function readSettingsFile(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {}; // corrupted - start fresh rather than crash setup
  }
}

/** Ensure the Gipity plugin is enabled at user scope (~/.claude/settings.json)
 *  via the documented declarative keys: register the marketplace under
 *  `extraKnownMarketplaces` and enable the plugin under `enabledPlugins`.
 *  Claude Code fetches both non-interactively at next launch. An explicit
 *  user disable (`"gipity@gipity": false`) is respected unless `force` -
 *  the user said no, and `gipity status --repair-hooks` is the deliberate
 *  way to say yes again. Also strips legacy Gipity hook blocks that older
 *  CLI versions left in the user-global settings. */
export function ensureGipityPlugin(force = false): void {
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readSettingsFile(settingsPath);

  let changed = stripGipityHooks(settings);

  const marketplaces = settings.extraKnownMarketplaces ?? (settings.extraKnownMarketplaces = {});
  const registered = marketplaces[GIPITY_MARKETPLACE_NAME];
  if (!registered || registered.source?.repo === LEGACY_MARKETPLACE_REPO) {
    marketplaces[GIPITY_MARKETPLACE_NAME] = {
      source: { source: 'github', repo: GIPITY_MARKETPLACE_REPO },
    };
    changed = true;
  }

  const enabled = settings.enabledPlugins ?? (settings.enabledPlugins = {});
  if (enabled[GIPITY_PLUGIN_ID] !== true && (force || !(GIPITY_PLUGIN_ID in enabled))) {
    enabled[GIPITY_PLUGIN_ID] = true;
    changed = true;
  }

  if (!changed) return;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/** Dotted-numeric version compare: true when `have` >= `want` (e.g. "0.4.0"). */
function versionGte(have: string, want: string): boolean {
  const h = have.split('.').map((n) => parseInt(n, 10) || 0);
  const w = want.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(h.length, w.length); i++) {
    const a = h[i] ?? 0;
    const b = w[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Parsed user-scope install state for the Gipity plugin, read straight from
 *  installed_plugins.json (no subprocess). `exists` is true when Claude Code
 *  records ANY user-scope install; `current` narrows that to one at >= the
 *  version this CLI needs. The two differ exactly when a stale install lags a
 *  plugin-version bump - the case that must be UPGRADED, not freshly installed
 *  (a bare `claude plugin install` no-ops on an already-present user install
 *  and never advances its version). */
export function userScopeInstallState(): { exists: boolean; current: boolean } {
  try {
    const p = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    const entries = data?.plugins?.[GIPITY_PLUGIN_ID];
    if (!Array.isArray(entries)) return { exists: false, current: false };
    const userEntries = entries.filter((e: any) => e?.scope === 'user');
    return {
      exists: userEntries.length > 0,
      current: userEntries.some(
        (e: any) => typeof e?.version === 'string' && versionGte(e.version, GIPITY_PLUGIN_VERSION),
      ),
    };
  } catch {
    return { exists: false, current: false };
  }
}

/** True when Claude Code already records a USER-scope install of the Gipity
 *  plugin at >= the version this CLI needs - the common case, letting the
 *  caller skip the (slow) reinstall. Reads installed_plugins.json directly so
 *  the check costs no subprocess. Exported so `gipity status` can tell an
 *  actually-loaded plugin apart from one that's merely enabled-but-uninstalled
 *  (which would otherwise read as a false-green "hooks enabled"). */
export function userScopePluginCurrent(): boolean {
  return userScopeInstallState().current;
}

/** Remove Gipity's entries from the user-scope Claude Code settings: the
 *  plugin enablement, the marketplace registration, and any legacy hook
 *  blocks older CLI versions wrote there. Surgical - everything else in the
 *  file (the user's own permissions, hooks, other plugins) is untouched.
 *  Used by `gipity uninstall` via the claude adapter's `setup.uninstall`. */
export function removeGipityPluginConfig(): boolean {
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

export function binaryOnPath(bin: string): boolean {
  const probe = spawnSyncCommand(process.platform === 'win32' ? 'where' : 'which', [bin], {
    encoding: 'utf-8',
  });
  return probe.status === 0 && !!probe.stdout?.toString().trim();
}

/** Materialize the Gipity plugin at USER scope via Claude Code's own plugin
 *  CLI, so its hooks (session capture + file sync) load in EVERY directory.
 *
 *  ensureGipityPlugin() only writes the declarative `enabledPlugins` /
 *  `extraKnownMarketplaces` keys. That was enough on older Claude Code, but
 *  CC >=2.1.x no longer materializes a user-scope install from an enablement
 *  entry alone: without an actual user-scope install the plugin loads only in
 *  whatever project happened to install it (often nowhere), so capture and
 *  file-sync silently go dark everywhere else. We drive the supported
 *  `claude plugin` commands rather than trust implicit resolution.
 *
 *  Best-effort and non-fatal - a missing `claude` or a failed install must
 *  never break `gipity claude`. Skips entirely when the user-scope install is
 *  already current, so it shells out at most once per plugin-version bump. */
export function ensureGipityPluginInstalled(): void {
  const state = userScopeInstallState();
  if (state.current) return;
  if (!binaryOnPath('claude')) return;
  // Refresh the marketplace clone so install/update resolves the current version.
  // resolveCommand: on Windows `claude` is a .cmd shim that spawn can't launch
  // without an explicit path, so resolve it (otherwise the command silently
  // ENOENTs and the plugin's hooks never land at user scope).
  const claudeCmd = resolveCommand('claude');
  spawnSyncCommand(claudeCmd, ['plugin', 'marketplace', 'update', GIPITY_MARKETPLACE_NAME], {
    stdio: 'ignore',
    timeout: 120_000,
  });
  // A bare `plugin install` only materializes a MISSING install - on an
  // already-present but stale user-scope install (the version this CLI just
  // bumped past) it no-ops and leaves the old version registered, so
  // userScopePluginCurrent() stays false forever and `gipity status` reports
  // `missing: install` on every run. `plugin update` is the command that
  // actually advances a registered user-scope install to the marketplace's
  // current version; `install` is only right when nothing is installed yet.
  const verb = state.exists
    ? ['plugin', 'update', GIPITY_PLUGIN_ID, '--scope', 'user']
    : ['plugin', 'install', GIPITY_PLUGIN_ID, '--scope', 'user'];
  spawnSyncCommand(claudeCmd, verb, {
    stdio: 'ignore',
    timeout: 120_000,
  });
}

// --- Grok Build (xAI) ------------------------------------------------------
// Grok Build reads Claude-format plugins natively - skills/, commands/,
// hooks/hooks.json, and the .claude-plugin/plugin.json manifest - and sets
// CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA aliases for plugin hooks, so the one
// GipityAI/skills repo serves both agents. A user-scope install
// (`grok plugin install <repo> --trust`) is trusted and enabled automatically,
// which gives Grok sessions the same skills and file-sync hooks as Claude Code.

/** Parsed install state for the Gipity plugin in Grok Build, read straight
 *  from ~/.grok/installed-plugins/registry.json (no subprocess). Mirrors
 *  {@link userScopeInstallState} for Claude Code. */
export function grokInstallState(): { exists: boolean; current: boolean } {
  try {
    const p = join(homedir(), '.grok', 'installed-plugins', 'registry.json');
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    const versions: string[] = [];
    for (const repo of Object.values<any>(data?.repos ?? {})) {
      const v = repo?.plugins?.gipity?.version;
      if (typeof v === 'string') versions.push(v);
    }
    return {
      exists: versions.length > 0,
      current: versions.some((v) => versionGte(v, GIPITY_PLUGIN_VERSION)),
    };
  } catch {
    return { exists: false, current: false };
  }
}

/** Install (or upgrade) the Gipity plugin in Grok Build. Best-effort and
 *  non-fatal, like the Claude Code counterpart: skips instantly when Grok
 *  isn't installed or the plugin is already current, so the steady-state cost
 *  is one registry.json read. */
export function ensureGrokPluginInstalled(): void {
  const state = grokInstallState();
  if (state.current) return;
  if (!binaryOnPath('grok')) return;
  const grokCmd = resolveCommand('grok');
  // `install` clones the repo; on an existing install `update <name>` is the
  // verb that refetches the source and advances the recorded version.
  const verb = state.exists
    ? ['plugin', 'update', 'gipity']
    : ['plugin', 'install', GIPITY_MARKETPLACE_REPO, '--trust'];
  const res = spawnSyncCommand(grokCmd, verb, { stdio: 'ignore', timeout: 120_000 });
  if (!state.exists && res.status === 0) {
    console.log('Installed the Gipity plugin for Grok (skills + file-sync hooks).');
  }
}

/** Uninstall the Gipity plugin from Grok Build, if present. Used by
 *  `gipity uninstall` via the grok adapter's `setup.uninstall`. */
export function removeGrokPlugin(): boolean {
  if (!grokInstallState().exists) return false;
  spawnSyncCommand(resolveCommand('grok'), ['plugin', 'uninstall', 'gipity', '--confirm'], {
    stdio: 'ignore',
    timeout: 60_000,
  });
  return true;
}

// --- OpenAI Codex ------------------------------------------------------------
// Codex has no Claude-plugin compatibility, but it reads the same SKILL.md
// skill format from the cross-agent `~/.agents/skills` directory (also read by
// OpenClaw and other agentskills.io adopters), and supports project hooks in
// `.codex/hooks.json` with Claude-style matcher groups (`Edit|Write` aliases
// its apply_patch tool). So Codex setup = copy the plugin's skills into
// ~/.agents/skills, stage its hook scripts under ~/.gipity/agent-hooks, and
// write a project .codex/hooks.json pointing at them. Codex requires the user
// to approve non-managed hooks once via /hooks - there is no supported way to
// pre-trust, so we print a nudge on first write.

export const AGENTS_SKILLS_DIR = join(homedir(), '.agents', 'skills');
export const AGENT_HOOKS_DIR = join(homedir(), '.gipity', 'agent-hooks');
/** Records what ensureAgentSkillsInstalled() put on this machine: the plugin
 *  version and the exact skill names copied, so upgrades replace and uninstall
 *  removes precisely those. */
export const AGENT_SKILLS_MANIFEST = join(homedir(), '.gipity', 'agent-skills.json');

// Antigravity (agy) reads skills from its own global customization root,
// ~/.gemini/config/skills/ (confirmed against agy's own customization-system
// docs) - NOT the cross-agent ~/.agents/skills Codex/OpenClaw-family tools
// share. Same manifest pattern, separate directory + file so upgrades and
// uninstall touch exactly the skills each tool actually reads.
export const AGY_SKILLS_DIR = join(homedir(), '.gemini', 'config', 'skills');
export const AGY_SKILLS_MANIFEST = join(homedir(), '.gipity', 'agy-skills.json');

function skillsManifestState(manifestPath: string): { current: boolean; skills: string[] } {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return {
      current: typeof m?.version === 'string' && versionGte(m.version, GIPITY_PLUGIN_VERSION),
      skills: Array.isArray(m?.skills) ? m.skills : [],
    };
  } catch {
    return { current: false, skills: [] };
  }
}

export function agentSkillsState(): { current: boolean; skills: string[] } {
  return skillsManifestState(AGENT_SKILLS_MANIFEST);
}

export function agySkillsState(): { current: boolean; skills: string[] } {
  return skillsManifestState(AGY_SKILLS_MANIFEST);
}

/** Remove exactly the skill dirs a manifest recorded (never someone else's
 *  skills) from `skillsDir`. Returns the count removed. Shared core for the
 *  Codex/agy adapters' `setup.uninstall`. */
function removeManifestSkills(skillsDir: string, manifestPath: string): number {
  const { skills } = skillsManifestState(manifestPath);
  for (const name of skills) {
    try { rmSync(join(skillsDir, name), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return skills.length;
}

/** Remove the Gipity skills copied into Codex's cross-agent ~/.agents/skills.
 *  Used by `gipity uninstall` via the codex adapter's `setup.uninstall`. */
export function removeAgentSkills(): number {
  return removeManifestSkills(AGENTS_SKILLS_DIR, AGENT_SKILLS_MANIFEST);
}

/** Remove the Gipity skills copied into Antigravity's own global skill root.
 *  Used by `gipity uninstall` via the agy adapter's `setup.uninstall`. */
export function removeAgySkills(): number {
  return removeManifestSkills(AGY_SKILLS_DIR, AGY_SKILLS_MANIFEST);
}

/** Shared core: clone GipityAI/skills, copy every skill dir with a SKILL.md
 *  into `skillsDir`, stage the plugin's hook scripts into ~/.gipity/agent-hooks
 *  (shared infra - launch.sh/capture.cjs/sync-push.cjs are agent-agnostic, so
 *  every caller re-stages them harmlessly), and record what was installed in
 *  `manifestPath`. Source of truth is the same GipityAI/skills repo the
 *  Claude/Grok plugin installs clone - fetched with a shallow git clone into a
 *  temp dir. Best-effort: no git, no network, or a failed clone all leave
 *  things as they were; the next init retries. */
function installSkillsAndHooks(skillsDir: string, manifestPath: string, harnessLabel: string): void {
  if (!binaryOnPath('git')) return;
  const tmp = mkdtempSync(join(tmpdir(), 'gipity-skills-'));
  try {
    const clone = spawnSyncCommand(
      resolveCommand('git'),
      ['clone', '--depth', '1', `https://github.com/${GIPITY_MARKETPLACE_REPO}.git`, join(tmp, 'repo')],
      { stdio: 'ignore', timeout: 120_000 },
    );
    if (clone.status !== 0) return;
    const repo = join(tmp, 'repo');

    let version = GIPITY_PLUGIN_VERSION;
    try {
      const manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf-8'));
      if (typeof manifest?.version === 'string') version = manifest.version;
    } catch { /* keep the CLI's pinned version */ }

    const skillsSrc = join(repo, 'skills');
    const names: string[] = [];
    for (const entry of readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(skillsSrc, entry.name, 'SKILL.md'))) continue;
      mkdirSync(skillsDir, { recursive: true });
      cpSync(join(skillsSrc, entry.name), join(skillsDir, entry.name), {
        recursive: true,
        force: true,
      });
      names.push(entry.name);
    }

    mkdirSync(AGENT_HOOKS_DIR, { recursive: true });
    for (const script of readdirSync(join(repo, 'hooks', 'scripts'))) {
      cpSync(join(repo, 'hooks', 'scripts', script), join(AGENT_HOOKS_DIR, script), { force: true });
    }

    writeFileSync(manifestPath, JSON.stringify({ version, skills: names }, null, 2) + '\n');
    console.log(`Installed ${names.length} Gipity skills for ${harnessLabel} (${skillsDir}).`);
  } catch { /* best-effort - never break setup */ } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Self-gating like ensureGipityPluginInstalled()/ensureGrokPluginInstalled():
 *  skips instantly when the codex binary is absent, so it's safe to call
 *  directly (e.g. via the codex adapter's `setup.install`) without a
 *  binaryOnPath() check at the call site. */
export function ensureAgentSkillsInstalled(): void {
  if (agentSkillsState().current) return;
  if (!binaryOnPath('codex')) return;
  installSkillsAndHooks(AGENTS_SKILLS_DIR, AGENT_SKILLS_MANIFEST, 'Codex');
}

/** Materialize the Gipity skills into Antigravity's global skill root. Mirrors
 *  ensureAgentSkillsInstalled() but targets agy's own directory - see the
 *  AGY_SKILLS_DIR comment above for why it differs from Codex's. Self-gating
 *  on the agy binary for the same reason. */
export function ensureAgySkillsInstalled(): void {
  if (agySkillsState().current) return;
  if (!binaryOnPath('agy')) return;
  installSkillsAndHooks(AGY_SKILLS_DIR, AGY_SKILLS_MANIFEST, 'Antigravity');
}

/** Pure core of the .codex/hooks.json merge: given the file's current content
 *  (`null` when absent), return the new content, or `null` when no change is
 *  needed. Adds the Gipity sync hook groups (push on file edits, pull before
 *  each prompt) AND the session-capture groups (SessionStart / throttled
 *  PostToolUse / Stop → capture.cjs, which mirrors the session into the web
 *  CLI; Codex has no SessionEnd or SubagentStop, so those are absent), while
 *  preserving any user-authored hooks. Our groups are recognized by their
 *  exact command string, so a re-run upgrades older sync-only files by adding
 *  just the missing capture entries. Exported for unit testing. */
export function applyCodexHooks(existing: string | null): string | null {
  const launcher = join(AGENT_HOOKS_DIR, 'launch.sh');
  const cmd = (script: string, ...args: string[]): string =>
    [`sh "${launcher}" "${join(AGENT_HOOKS_DIR, script)}"`, ...args].join(' ');
  const wanted: Array<{ event: string; matcher?: string; command: string; timeout: number }> = [
    { event: 'PostToolUse', matcher: 'Edit|Write', command: cmd('sync-push.cjs'), timeout: 30 },
    { event: 'UserPromptSubmit', command: cmd('sync-pull.cjs'), timeout: 300 },
    // Session capture: mirror the Codex session into the Gipity web CLI.
    { event: 'SessionStart', command: cmd('capture.cjs', 'codex', 'session-start'), timeout: 30 },
    { event: 'PostToolUse', command: cmd('capture.cjs', 'codex', 'post-tool-use'), timeout: 30 },
    { event: 'Stop', command: cmd('capture.cjs', 'codex', 'stop'), timeout: 60 },
  ];

  let settings: Record<string, any> = {};
  if (existing !== null) {
    try {
      settings = JSON.parse(existing);
    } catch {
      return null; // user file we can't parse - leave it alone
    }
  }
  const hooks = settings.hooks ?? (settings.hooks = {});
  let changed = false;
  for (const w of wanted) {
    const groups: any[] = Array.isArray(hooks[w.event]) ? hooks[w.event] : (hooks[w.event] = []);
    const present = groups.some((g: any) =>
      Array.isArray(g?.hooks) && g.hooks.some(
        (h: any) => typeof h?.command === 'string' && h.command === w.command,
      ),
    );
    if (present) continue;
    const group: Record<string, any> = { hooks: [{ type: 'command', command: w.command, timeout: w.timeout }] };
    if (w.matcher) group.matcher = w.matcher;
    groups.push(group);
    changed = true;
  }
  return changed ? JSON.stringify(settings, null, 2) + '\n' : null;
}

/** Write the project-level Codex hooks (.codex/hooks.json). POSIX only - the
 *  commands run through the same sh launcher the plugin uses; Codex on Windows
 *  would need commandWindows variants (not wired yet). */
export function setupCodexHooks(): void {
  if (process.platform === 'win32') return;
  const cwd = resolve(process.cwd());
  if (cwd === resolve(homedir())) return; // never treat $HOME as a project
  const path = join(cwd, '.codex', 'hooks.json');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const next = applyCodexHooks(existing);
  if (next === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  if (existing === null) {
    console.log('Wrote Codex sync + session-capture hooks (.codex/hooks.json) - approve them once with /hooks inside Codex.');
  } else {
    console.log('Updated Codex hooks (.codex/hooks.json) - if Codex asks, re-approve them via /hooks.');
  }
}

/** Full Codex integration: user-scope skills + project sync hooks. Gated on
 *  the codex binary so machines without Codex get only the AGENTS.md primer. */
export function setupCodexIntegration(): void {
  if (!binaryOnPath('codex')) return;
  ensureAgentSkillsInstalled();
  setupCodexHooks();
}

// --- opencode ----------------------------------------------------------------
// opencode reads the same cross-agent ~/.agents/skills directory Codex does
// (it walks .agents/skills natively), so its skills install shares the Codex
// dir + manifest. Its deeper integration - the Gipity plugin providing the
// model slot and session capture - lives in opencode-setup.ts; the plugin file
// itself ships in the GipityAI/skills repo (hooks/scripts/opencode-plugin.mjs)
// and is staged into ~/.gipity/agent-hooks by installSkillsAndHooks like every
// other hook script.

/** Materialize the Gipity skills for opencode. Shares AGENTS_SKILLS_DIR (and
 *  the manifest) with Codex - both read the same cross-agent directory - but
 *  gates on the opencode binary so either tool being present is enough. */
export function ensureOpencodeSkillsInstalled(): void {
  if (agentSkillsState().current) return;
  if (!binaryOnPath('opencode')) return;
  installSkillsAndHooks(AGENTS_SKILLS_DIR, AGENT_SKILLS_MANIFEST, 'opencode');
}

/** Full opencode integration: user-scope skills + the Gipity opencode plugin
 *  (model provider + session capture). Gated on the opencode binary. The
 *  import cycle with opencode-setup.ts (it reads AGENT_HOOKS_DIR from here)
 *  is safe: neither module calls into the other at module-eval time. */
export function setupOpencodeIntegration(): void {
  if (!binaryOnPath('opencode')) return;
  ensureOpencodeSkillsInstalled();
  ensureOpencodePluginInstalled();
}

// --- Google Antigravity (agy) --------------------------------------------
// agy's hook system is a real departure from the Claude-format hooks Codex
// and Grok reuse: project hooks live in `.agents/hooks.json` as a NAMED-block
// object (not a flat `hooks` key), tool-scoped events (PreToolUse/PostToolUse)
// require a `matcher` regex, and every hook command must print a JSON object
// on stdout.
//
// Deliberately NOT wired: PreToolUse. Gipity only needs to OBSERVE tool calls
// (capture) and react after a write lands (sync-push) - it has no reason to
// gate them. A PreToolUse hook that answers `{"decision":"allow"}` genuinely
// overrides agy's own approval prompt (confirmed against agy's own hooks
// contract: `"allow"` means "automatically allow the tool execution"), so
// registering one would auto-approve every tool agy runs - including shell
// commands - in every Gipity-linked project, in BOTH headless and interactive
// sessions. Confirmed live that headless `-p` writes succeed with no
// PreToolUse hook at all, with or without `--dangerously-skip-permissions` -
// so there is no capture/sync reason to have one, and Claude/Codex don't
// silently touch agent approval either. PostToolUse/Stop route through a
// small wrapper script (AGY_HOOKS_SCRIPT below) that does the real work
// (sync-push + session capture) and then unconditionally prints `{}` - not
// decision-gated, so degrading silently on a node-resolution failure is the
// same acceptable risk every other harness's hooks already carry.

/** Written verbatim into ~/.gipity/agent-hooks/agy-hooks.cjs by setupAgyHooks().
 *  Unlike Codex's hook scripts (cloned from the GipityAI/skills repo), this
 *  file is authored by the CLI itself - agy is not part of that repo's plugin
 *  ecosystem, just a consumer of the same shared sync-push.cjs/capture.cjs.
 *
 *  post-tool-use: reads agy's PostToolUse payload (which - confirmed live -
 *  carries `toolCall` directly, unlike agy's own docs suggest) and, for a
 *  file-write tool, synthesizes a Claude-Code-shaped `{tool_input:{file_path}}`
 *  payload for the UNMODIFIED sync-push.cjs (which only knows Claude/Grok's
 *  field names) - then always forwards the raw payload to capture.cjs for
 *  session mirroring (its normalizeHookInput already reads agy's camelCase
 *  conversationId/transcriptPath fields).
 *  stop: forwards the raw payload to capture.cjs for a final flush.
 *  Either way, stdout is always `{}` - agy isn't gating on this response. */
const AGY_HOOKS_SCRIPT = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { join } = require('path');

const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content']);

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
  });
}

async function main() {
  const event = process.argv[2];
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* keep {} */ }

  try {
    if (event === 'post-tool-use') {
      const toolCall = payload.toolCall;
      const filePath = toolCall && toolCall.args && toolCall.args.TargetFile;
      if (toolCall && WRITE_TOOLS.has(toolCall.name) && typeof filePath === 'string' && filePath) {
        spawnSync(process.execPath, [join(__dirname, 'sync-push.cjs')], {
          input: JSON.stringify({ tool_input: { file_path: filePath } }),
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
        });
      }
      spawnSync(process.execPath, [join(__dirname, 'capture.cjs'), 'agy', 'post-tool-use'], {
        input: raw,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } else if (event === 'stop') {
      spawnSync(process.execPath, [join(__dirname, 'capture.cjs'), 'agy', 'stop'], {
        input: raw,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    }
  } catch { /* never let a side effect break the response below */ }

  process.stdout.write('{}');
}

main();
`;

/** Pure core of the .agents/hooks.json merge for Antigravity (agy). Given the
 *  file's current content (`null` when absent), return the new content, or
 *  `null` when no change is needed. Our whole contribution lives under one
 *  named key ('gipity'), so a re-run replaces it wholesale (simpler than
 *  Codex's per-entry merge, and fine here since nothing else writes into this
 *  key) while any other named hook block - the user's own, or another tool's -
 *  is preserved untouched. Exported for unit testing. */
export function applyAgyHooks(existing: string | null): string | null {
  const wrapper = join(AGENT_HOOKS_DIR, 'agy-hooks.cjs');
  const launcher = join(AGENT_HOOKS_DIR, 'launch.sh');
  const wrapCmd = (event: string): string => `sh "${launcher}" "${wrapper}" ${event}`;

  const block = {
    PostToolUse: [
      { matcher: '.*', hooks: [{ type: 'command', command: wrapCmd('post-tool-use'), timeout: 30 }] },
    ],
    // Stop (like PreInvocation/PostInvocation) is FLAT in agy's schema - a
    // list of handler objects directly, NOT wrapped in a {matcher, hooks}
    // group like PreToolUse/PostToolUse. Confirmed live: the wrapped shape
    // silently invalidates the WHOLE named block (PostToolUse stopped firing
    // too, not just Stop) - agy gives no parse error, it just never fires.
    Stop: [
      { type: 'command', command: wrapCmd('stop'), timeout: 60 },
    ],
  };

  let settings: Record<string, any> = {};
  if (existing !== null) {
    try {
      settings = JSON.parse(existing);
    } catch {
      return null; // user file we can't parse - leave it alone
    }
  }
  if (JSON.stringify(settings.gipity ?? null) === JSON.stringify(block)) return null; // already current
  settings.gipity = block;
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Write the project-level Antigravity hooks (.agents/hooks.json) and stage
 *  the wrapper script it invokes. POSIX only, same constraint as Codex's
 *  hooks (the commands run through a POSIX sh launcher). */
export function setupAgyHooks(): void {
  if (process.platform === 'win32') return;
  const cwd = resolve(process.cwd());
  if (cwd === resolve(homedir())) return; // never treat $HOME as a project
  mkdirSync(AGENT_HOOKS_DIR, { recursive: true });
  writeFileSync(join(AGENT_HOOKS_DIR, 'agy-hooks.cjs'), AGY_HOOKS_SCRIPT);

  const path = join(cwd, '.agents', 'hooks.json');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const next = applyAgyHooks(existing);
  if (next === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  console.log(existing === null
    ? 'Wrote Antigravity sync + session-capture hooks (.agents/hooks.json).'
    : 'Updated Antigravity hooks (.agents/hooks.json).');
}

/** Full Antigravity integration: skills at its own global root + project sync
 *  hooks. Gated on the agy binary so machines without it get only the
 *  AGENTS.md primer. Unlike Codex, agy needs no one-time hook-approval nudge -
 *  confirmed live that project hooks fire without any manual trust step. */
export function setupAgyIntegration(): void {
  if (!binaryOnPath('agy')) return;
  ensureAgySkillsInstalled();
  setupAgyHooks();
}

export function setupClaudeHooks(): void {
  // All hooks ship in the plugin - enable it at user scope (and clean up any
  // legacy hook blocks in the user-global settings while we're there).
  ensureGipityPlugin();

  // Never treat the home directory as a project. A gipity command run from
  // $HOME used to write "project" hooks straight into the user-global
  // ~/.claude/settings.json; permissions are project-scoped, so at $HOME
  // there is nothing project-level left to do.
  const cwd = resolve(process.cwd());
  if (cwd === resolve(homedir())) return;

  const claudeDir = join(cwd, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readSettingsFile(settingsPath);

  // Migration: remove the hook blocks older CLI versions wrote here.
  stripGipityHooks(settings);

  // Merge permissions (additive - preserve user's existing allows)
  const perms = settings.permissions || {};
  if (!perms.allow) perms.allow = [];
  for (const entry of PERMISSIONS_SETTINGS.permissions.allow) {
    if (!perms.allow.includes(entry)) {
      perms.allow.push(entry);
    }
  }
  settings.permissions = perms;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/** Markers delimiting the Gipity-managed section of CLAUDE.md / AGENTS.md.
 *  HTML comments, so they're invisible in rendered markdown. These strings
 *  are stable - changing them would orphan the blocks in existing files. */
export const GIPITY_BLOCK_BEGIN = '<!-- BEGIN GIPITY INTEGRATION - auto-generated by gipity, do not edit this block -->';
export const GIPITY_BLOCK_END = '<!-- END GIPITY INTEGRATION -->';

/** The Gipity-owned section, marker-wrapped: the integration guide + the full
 *  scaffold rule + the definition of done. The rule and DoD used to be injected
 *  only into the interactive `gipity claude` seed; folding the *static* parts
 *  into the primer means every agent (Claude, Codex, Gemini, ...) gets them, and
 *  the seed no longer has to carry that context.
 *
 *  Per-project values (GUID, live URL) deliberately do NOT live here - baking
 *  them into a generated doc is the wrong layer. The CLI surfaces them where the
 *  agent actually looks: `gipity deploy` prints the live URL, `gipity status` and
 *  `gipity project info` show the URL + GUID. That keeps them authoritative and
 *  avoids stale values frozen into a file.
 *
 *  The one environment value that DOES live here is the API base. The baked
 *  knowledge text names `https://a.gipity.ai` as the app-services endpoint;
 *  when this session runs against a different platform instance (GIPITY_API_BASE
 *  / --api-base, e.g. a local dev server), the project only exists there - an
 *  agent that copies the public host into app code gets 404s it can't explain.
 *  So the block is rendered against the resolved base, with a note naming the
 *  instance. The block is fully regenerated each session, so it tracks the
 *  environment rather than going stale. */
function renderManagedBlock(apiBase: string): string {
  let body = [SKILLS_CONTENT, BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE].join('\n\n');
  const base = apiBase.replace(/\/+$/, '');
  if (base !== DEFAULT_API_BASE) {
    body = body.replaceAll(DEFAULT_API_BASE, base);
    const note = `> **Platform instance:** this project runs against the Gipity platform at \`${base}\`, not the public \`${DEFAULT_API_BASE}\`. The project and its data exist only on that instance; every API/service URL in this document already points there - never substitute \`a.gipity.ai\`.`;
    const headingEnd = body.indexOf('\n');
    body = body.slice(0, headingEnd + 1) + '\n' + note + '\n' + body.slice(headingEnd + 1);
  }
  return `${GIPITY_BLOCK_BEGIN}\n${body}\n${GIPITY_BLOCK_END}`;
}

/**
 * Pure core of `writeSkillsFile`: given a file's current content (or `null`
 * when the file does not exist), return what it should contain.
 *
 * The Gipity block is fully managed - every run replaces it with the current
 * SKILLS_CONTENT, so skill-catalog changes reach existing projects. Anything
 * outside the markers is the user's own content and is preserved verbatim.
 *
 *   - no file            -> the managed block
 *   - marked block found -> replace between the markers, keep the rest
 *   - legacy unmarked    -> from older CLIs the `# Gipity Integration` block
 *                           was appended last and ran to EOF; drop it and
 *                           append a fresh marked block
 *   - no Gipity block    -> append a marked block, keep the user's content
 *
 * Exported for unit testing.
 */
export function applySkillsBlock(existing: string | null, apiBase: string = DEFAULT_API_BASE): string {
  const block = renderManagedBlock(apiBase);
  if (existing === null) return block + '\n';

  let next: string;
  const beginIdx = existing.indexOf(GIPITY_BLOCK_BEGIN);
  if (beginIdx !== -1) {
    // Marked block - replace between the markers, preserve everything else.
    const endAt = existing.indexOf(GIPITY_BLOCK_END, beginIdx);
    const after = endAt !== -1 ? existing.slice(endAt + GIPITY_BLOCK_END.length) : '\n';
    next = existing.slice(0, beginIdx) + block + after;
  } else {
    // No markers. A legacy block always ran from the `# Gipity Integration`
    // heading to EOF (older CLIs appended it last); with no such heading the
    // whole file is the user's own content.
    const legacyIdx = existing.indexOf('# Gipity Integration');
    const head = (legacyIdx !== -1 ? existing.slice(0, legacyIdx) : existing).trimEnd();
    next = (head ? head + '\n\n' : '') + block + '\n';
  }
  return next.endsWith('\n') ? next : next + '\n';
}

/** Write or refresh the Gipity integration block in a primer file.
 *  Skips the write when nothing changed, to avoid needless file churn.
 *  `wrap` lets a tool prepend tool-specific frontmatter (e.g. Cursor's .mdc). */
function writeSkillsFile(relPath: string, wrap?: (block: string) => string): void {
  const path = resolve(process.cwd(), relPath);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const baseNext = applySkillsBlock(existing, resolveApiBase());
  // Frontmatter wrap only applies on first write (no existing content).
  // Re-runs preserve user content outside the managed block, including
  // any frontmatter they may have added themselves.
  const next = wrap && existing === null ? wrap(baseNext) : baseNext;
  if (next !== existing) writeFileSync(path, next);
}

export function setupClaudeMd(): void {
  writeSkillsFile(PRIMER_FILES.claude);
}

export function setupAgentsMd(): void {
  writeSkillsFile(PRIMER_FILES.codex);
}

/** Pure core of the aider conf merge: given `.aider.conf.yml`'s current
 *  content (`null` when the file doesn't exist), return what it should
 *  contain, or `null` when no change is needed. Aider auto-discovers nothing
 *  (not AGENTS.md, not even its own CONVENTIONS.md convention) - it only loads
 *  instruction files named by a `read:` entry in its conf. Hand-rolled line
 *  edits (the CLI has no YAML dep) covering the three `read:` shapes aider
 *  documents: flow list, scalar, and block list. A user's existing entries and
 *  unrelated keys are preserved. Exported for unit testing. */
export function applyAiderConf(existing: string | null): string | null {
  const entry = PRIMER_FILES.aider;
  if (existing === null) {
    return [
      '# Generated by gipity. `read:` loads the Gipity integration guide into',
      '# every aider chat: https://aider.chat/docs/usage/conventions.html',
      `read: [${entry}]`,
      '',
    ].join('\n');
  }

  // Already wired? Check only non-comment lines, so a commented-out
  // `# read: [AGENTS.md]` doesn't mask a missing live entry.
  const live = existing.split('\n').filter(l => !l.trimStart().startsWith('#'));
  if (live.some(l => l.includes(entry))) return null;

  const lines = existing.split('\n');
  const readIdx = lines.findIndex(l => /^read:/.test(l));
  if (readIdx === -1) {
    return existing.trimEnd() + (existing.trim() ? '\n\n' : '') + `read: [${entry}]\n`;
  }

  const value = lines[readIdx].slice('read:'.length).replace(/#.*$/, '').trim();
  if (value.startsWith('[')) {
    // Flow list: `read: [a, b]` or empty `read: []` - append inside the brackets.
    lines[readIdx] = value === '[]'
      ? lines[readIdx].replace(/\[\s*\]/, `[${entry}]`)
      : lines[readIdx].replace(']', `, ${entry}]`);
  } else if (value) {
    // Scalar: `read: CONVENTIONS.md` - promote to a flow list.
    lines[readIdx] = `read: [${value}, ${entry}]`;
  } else {
    // Block list (items on following `- ` lines) - add one, matching indent.
    const indent = /^(\s*)-\s/.exec(lines[readIdx + 1] ?? '')?.[1] ?? '  ';
    lines.splice(readIdx + 1, 0, `${indent}- ${entry}`);
  }
  return lines.join('\n');
}

/** Aider setup = the shared AGENTS.md primer (the same file Codex reads) plus
 *  a `read:` entry in `.aider.conf.yml` pointing aider at it. */
export function setupAiderMd(): void {
  writeSkillsFile(PRIMER_FILES.aider);
  const path = resolve(process.cwd(), AIDER_CONF_FILE);
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const next = applyAiderConf(existing);
  if (next !== null) writeFileSync(path, next);
}

/** Gemini CLI auto-discovers GEMINI.md in the working directory. */
export function setupGeminiMd(): void {
  writeSkillsFile(PRIMER_FILES.gemini);
}

/** GitHub Copilot CLI (and Copilot in VS Code) auto-discovers
 *  `.github/copilot-instructions.md`. */
export function setupCopilotMd(): void {
  writeSkillsFile(PRIMER_FILES.copilot);
}

/** Cursor reads rule files from `.cursor/rules/`. The `.mdc` format wants
 *  YAML frontmatter; `alwaysApply: true` makes it load on every chat. */
export function setupCursorMd(): void {
  writeSkillsFile(PRIMER_FILES.cursor, (block) =>
    `---\ndescription: Gipity platform integration - CLI, sandbox, app services\nalwaysApply: true\n---\n\n${block}`,
  );
}

/** All supported coding tools: the primer each gets (`setup`) plus, for tools
 *  with a deeper Gipity integration, an `integrate` step that installs the
 *  Gipity skills and file-sync hooks into that tool's own ecosystem (Claude
 *  Code plugin, Grok Build plugin, Codex ~/.agents/skills + .codex hooks).
 *  Integrations are best-effort and self-gating - each no-ops fast when its
 *  binary is missing or the install is already current - so running the whole
 *  default set on every init/launch is cheap and keeps all detected agents in
 *  lockstep. Order matters for help-text rendering and the `all` expansion.
 *  `optIn` tools are excluded from the default / `all` set and must be named
 *  explicitly (`--for aider`): aider's setup writes `.aider.conf.yml`, which
 *  changes how aider behaves in this directory - a heavier footprint than
 *  dropping an inert markdown primer. */
export const SUPPORTED_TOOLS: Array<{ key: string; label: string; setup: () => void; integrate?: () => void; optIn?: boolean }> = [
  { key: 'claude',  label: 'Claude Code (CLAUDE.md + Gipity plugin)',              setup: setupClaudeMd,  integrate: setupClaudeHooks },
  { key: 'codex',   label: 'OpenAI Codex (AGENTS.md + skills + sync hooks)',       setup: setupAgentsMd,  integrate: setupCodexIntegration },
  { key: 'grok',    label: 'Grok Build (AGENTS.md + Gipity plugin)',               setup: setupAgentsMd,  integrate: ensureGrokPluginInstalled },
  { key: 'agy',     label: 'Antigravity (AGENTS.md + skills + sync hooks)',        setup: setupAgentsMd,  integrate: setupAgyIntegration },
  { key: 'opencode', label: 'opencode (AGENTS.md + skills + Gipity plugin)',       setup: setupAgentsMd,  integrate: setupOpencodeIntegration },
  { key: 'aider',   label: 'Aider (AGENTS.md + .aider.conf.yml)',                  setup: setupAiderMd, optIn: true },
  { key: 'gemini',  label: 'Gemini CLI (GEMINI.md)',                               setup: setupGeminiMd },
  { key: 'copilot', label: 'GitHub Copilot (.github/copilot-instructions.md)',     setup: setupCopilotMd },
  { key: 'cursor',  label: 'Cursor (.cursor/rules/gipity.mdc)',                    setup: setupCursorMd },
];

/** The primer set written when the user makes no explicit `--for` choice:
 *  every tool except opt-in ones. */
export const DEFAULT_TOOLS = SUPPORTED_TOOLS.filter(t => !t.optIn);

/** Registry-driven project setup - the single entry point every "link this
 *  directory" path shares (`init`, `project create`, `gipity claude`, the
 *  relay daemon). Writes each requested tool's primer, runs its integration
 *  (hooks/skills install) when it has one, and refreshes .gitignore. Replaces
 *  the setupClaudeHooks/setupClaudeMd/setupAgentsMd/setupGitignore quartet
 *  that used to be copy-pasted per call site and silently skipped newer tools. */
export function setupProjectTools(tools: typeof SUPPORTED_TOOLS = DEFAULT_TOOLS): void {
  for (const t of tools) {
    t.setup();
    t.integrate?.();
  }
  setupGitignore();
}

export function setupGitignore(): void {
  const gitignorePath = resolve(process.cwd(), '.gitignore');
  // Sync already skips the scratch namespaces (DEFAULT_SYNC_IGNORE); ignore them
  // in git too so ephemeral conversion/staging work never gets committed.
  const entries = ['.gipity/', '.gipity.json', ...SCRATCH_IGNORE];

  if (existsSync(gitignorePath)) {
    let content = readFileSync(gitignorePath, 'utf-8');
    // Split on \r?\n so a CRLF .gitignore (the Windows default) doesn't leave a
    // trailing \r on each entry - otherwise `lines.includes('.gipity/')` never
    // matches '.gipity/\r' and every run re-appends the entries as duplicates.
    const lines = content.split(/\r?\n/);
    const toAdd = entries.filter(e => !lines.includes(e));
    if (toAdd.length > 0) {
      content = content.trimEnd() + '\n' + toAdd.join('\n') + '\n';
      writeFileSync(gitignorePath, content);
    }
  } else {
    writeFileSync(gitignorePath, entries.join('\n') + '\n');
  }
}

/** The server caps slugs at 50 (MAX_PROJECT_SLUG_LENGTH); we cap shorter for
 *  readability, since the slug is also the on-disk folder and the URL path
 *  segment. Keeps long-named directories from producing valid-but-ugly slugs. */
export const MAX_SLUG_LENGTH = 40;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  // Cut at the last word (hyphen) boundary within the cap so we don't slice
  // mid-word (e.g. "...call-no"). Fall back to a hard cut if the first word
  // alone already exceeds the cap.
  const cut = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
}

/**
 * Shared project setup helpers used by both `init` and `claude`.
 */
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolveCommand, spawnSyncCommand } from './platform.js';
import { SKILLS_CONTENT, BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE } from './knowledge.js';

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
  'node_modules', '.git', '.gipity.json', '.gipity/', '.claude/', '.gitignore', AIDER_CONF_FILE,
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
export const GIPITY_PLUGIN_VERSION = '0.5.0';

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

function claudeOnPath(): boolean {
  const probe = spawnSyncCommand(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
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
  if (!claudeOnPath()) return;
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
 *  avoids stale values frozen into a file. */
function renderManagedBlock(): string {
  const body = [SKILLS_CONTENT, BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE].join('\n\n');
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
export function applySkillsBlock(existing: string | null): string {
  const block = renderManagedBlock();
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
  const baseNext = applySkillsBlock(existing);
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

/** All supported coding-tool primers and the function that writes each.
 *  Order matters for help-text rendering and the `all` expansion.
 *  `optIn` tools are excluded from the default / `all` set and must be named
 *  explicitly (`--for aider`): aider's setup writes `.aider.conf.yml`, which
 *  changes how aider behaves in this directory - a heavier footprint than
 *  dropping an inert markdown primer. */
export const SUPPORTED_TOOLS: Array<{ key: string; label: string; setup: () => void; optIn?: boolean }> = [
  { key: 'claude',  label: 'Claude Code (CLAUDE.md)',                              setup: setupClaudeMd },
  { key: 'codex',   label: 'OpenAI Codex (AGENTS.md)',                             setup: setupAgentsMd },
  { key: 'aider',   label: 'Aider (AGENTS.md + .aider.conf.yml)',                  setup: setupAiderMd, optIn: true },
  { key: 'gemini',  label: 'Gemini CLI (GEMINI.md)',                               setup: setupGeminiMd },
  { key: 'copilot', label: 'GitHub Copilot (.github/copilot-instructions.md)',     setup: setupCopilotMd },
  { key: 'cursor',  label: 'Cursor (.cursor/rules/gipity.mdc)',                    setup: setupCursorMd },
];

/** The primer set written when the user makes no explicit `--for` choice:
 *  every tool except opt-in ones. */
export const DEFAULT_TOOLS = SUPPORTED_TOOLS.filter(t => !t.optIn);

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

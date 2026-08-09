import { Command } from 'commander';
import { join, dirname, resolve, basename, sep } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { resolveCommand, spawnCommand, spawnSyncCommand } from '../platform.js';
import { getAuth, sessionExpired, accessTokenExpired, refreshTokenIfNeeded } from '../auth.js';
import { get, post, ApiError, getAccountSlug } from '../api.js';
import { interactiveLogin } from '../login-flow.js';
import { getConfig, saveConfigAt, clearConfigCache, getApiBaseOverride, DEFAULT_API_BASE, getConfigPath } from '../config.js';
import { sync, type SyncResult } from '../sync.js';
import { slugify, ensureGipityPluginInstalled, setupProjectTools, setupToolForAgent, DEFAULT_SYNC_IGNORE, isSyncIgnored } from '../setup.js';
import {
  buildProjectContextBlock as buildProjectContextBlockText,
  buildNewProjectPrompt,
  buildResumeWrap,
  buildFreshWrap,
} from '../prompts.js';
import * as relayState from '../relay/state.js';
import { maybeOfferRelayOn, ensureDaemonRunning } from '../relay/onboarding.js';
import { prompt, promptBoxed, pickOne, confirm } from '../utils.js';
import { brand, bold, faint, info, success, warning, error as clrError, muted } from '../colors.js';
import { createProgressReporter } from '../progress.js';
import { printBanner } from '../banner.js';
import {
  scanForAdoption,
  isLikelyEmpty,
  canAdoptCwd,
  formatCwdLabel,
  formatBytes,
  adoptCurrentDir,
  ADOPT_THRESHOLDS,
} from '../adopt-cwd.js';
import { isClaudeInstalled, ensureClaudeInstalled, CLAUDE_PACKAGE } from '../claude-setup.js';
import { AGENT_ADAPTERS, AGENT_KEYS, getAdapter, type RemoteAgentAdapter } from '../agents/index.js';
import { readPrefs, writePrefs } from '../prefs.js';
import { binaryOnPath } from '../setup.js';

const __clDir = dirname(fileURLToPath(import.meta.url));
// Walk up to the nearest gipity package.json instead of a hardcoded '../..':
// the per-module tsc layout puts this file at dist/commands/, the bundled CLI
// at dist/, so a fixed depth breaks one of the two layouts.
function readOwnPkg(fromDir: string): { version?: string } {
  for (let d = fromDir; ; d = dirname(d)) {
    const p = join(d, 'package.json');
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf-8'));
        if (pkg.name === 'gipity') return pkg;
      } catch { /* keep walking */ }
    }
    if (dirname(d) === d) return {};
  }
}
const __clPkg = readOwnPkg(__clDir);

/** Report a sync run to the user. Beyond the applied-changes line, this SURFACES
 *  sync.errors - a download that came back incomplete (truncated bulk tar, a file
 *  that couldn't be refetched) lands here, so we never print "ready" over a
 *  half-synced project as if nothing went wrong. Deletions are disarmed on an
 *  incomplete pull, so we can tell the user plainly that nothing was deleted. */
function reportSyncResult(result: SyncResult): void {
  if (result.aborted) {
    console.log(`  ${warning('Merge cancelled - this folder was NOT synced with the project.')}`);
    console.log(`  ${muted('For a clean copy, quit and open the project in an empty folder. To merge anyway, run `gipity sync`.')}`);
    return;
  }
  if (result.applied > 0) {
    console.log(`  Synced ${result.applied} change${result.applied > 1 ? 's' : ''} with Gipity.`);
  }
  if (result.errors.length) {
    console.log(`  ${warning(`Sync finished with ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} - your local copy may be incomplete:`)}`);
    for (const e of result.errors.slice(0, 8)) console.log(`    - ${e}`);
    if (result.errors.length > 8) console.log(`    ...and ${result.errors.length - 8} more.`);
    console.log(`  ${muted('Nothing was deleted. Re-run `gipity sync` to finish the pull.')}`);
  }
}

import { getProjectsRoot } from '../relay/paths.js';

interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
  is_default?: number;
}

interface AgentData {
  short_guid: string;
  name: string;
}

interface ProjectStats {
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  topLevel: string;
}

/** Ask the server for recursive VFS counts. Server owns the file metadata
 *  (counts, bytes, paths), so a single aggregate query beats walking the
 *  local filesystem - which only sees depth 1 without recursion and led
 *  to the "1 top-level entry (src/)" bug for scaffolded projects where
 *  everything is under src/.
 *
 *  Returns a best-effort local fallback if the API call fails (offline,
 *  auth missing, etc.) so the prompt still builds. */
export async function fetchProjectStats(projectGuid: string, cwd: string): Promise<ProjectStats> {
  if (projectGuid) {
    try {
      const res = await get<{ data: {
        file_count: number;
        folder_count: number;
        total_bytes: number;
        top_level: Array<{ name: string; type: 'file' | 'directory' }>;
      } }>(`/projects/${encodeURIComponent(projectGuid)}/files/stats`);
      const d = res.data;
      const topLevelNames = d.top_level.map(e => e.type === 'directory' ? `${e.name}/` : e.name);
      return {
        fileCount: d.file_count,
        folderCount: d.folder_count,
        totalBytes: d.total_bytes,
        topLevel: topLevelNames.length ? topLevelNames.slice(0, 20).join(', ') : '(empty directory)',
      };
    } catch { /* fall through to local walk */ }
  }
  return localFsFallback(cwd);
}

/** Local-filesystem fallback for when the stats API isn't reachable.
 *  Recursive walk (unlike the old top-level-only version). Caps entries to
 *  keep the prompt bounded. */
function localFsFallback(dir: string): ProjectStats {
  let fileCount = 0;
  let folderCount = 0;
  let totalBytes = 0;
  const topLevelEntries: string[] = [];
  const walk = (d: string, depth: number): void => {
    try {
      for (const name of readdirSync(d).sort()) {
        if (isSyncIgnored(name)) continue;
        let isDir = false;
        let size = 0;
        try {
          const st = statSync(join(d, name));
          isDir = st.isDirectory();
          size = st.isFile() ? st.size : 0;
        } catch { continue; }
        if (isDir) {
          folderCount++;
          if (depth === 0) topLevelEntries.push(`${name}/`);
          walk(join(d, name), depth + 1);
        } else {
          fileCount++;
          totalBytes += size;
          if (depth === 0) topLevelEntries.push(name);
        }
      }
    } catch { /* unreadable */ }
  };
  walk(dir, 0);
  const topLevel = topLevelEntries.length
    ? topLevelEntries.slice(0, 20).join(', ') + (topLevelEntries.length > 20 ? ', ...' : '')
    : '(empty directory)';
  return { fileCount, folderCount, totalBytes, topLevel };
}

/** Thin wrappers that fetch VFS stats, then delegate the actual prompt
 *  assembly to `prompts.ts`. All wording lives in that module - keep it
 *  that way. */
interface LocalCtxOpts {
  projectName: string;
  projectSlug: string;
  projectGuid: string;
  accountSlug: string;
  cwd: string;
}

async function buildProjectContextBlock(opts: LocalCtxOpts): Promise<string> {
  const stats = await fetchProjectStats(opts.projectGuid, opts.cwd);
  return buildProjectContextBlockText({ ...opts, ...stats });
}

// Interactive email+code login now lives in `login-flow.ts` (shared with
// `gipity setup`). Used on first login and when the server returns 401
// mid-command (session expired).

// First-run relay onboarding now lives in `relay/onboarding.ts`
// (`maybeOfferRelayOn`). `gipity claude` invokes it after project
// selection, and also calls `ensureDaemonRunning` unconditionally before
// launching Claude Code so a paired user doesn't have to think about it.

/** Format a millisecond duration as hh:mm:ss.s (one decimal on seconds). */
function formatElapsed(ms: number): string {
  const totalSec = ms / 1000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(h)}:${pad2(m)}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Pre-accept Claude Code's per-directory workspace-trust dialog for a
 *  Gipity-managed project directory. `gipity claude` only ever launches the
 *  agent in a project the user created or explicitly chose, so the dialog is
 *  pure friction here - and a fresh `project-NNN` dir is untrusted on every
 *  interactive run.
 *
 *  Writes `projects["<dir>"].hasTrustDialogAccepted = true` into
 *  `~/.claude.json` - the exact entry Claude records when the user clicks
 *  "Yes". Purely additive (a path Claude hadn't seen); every other key is
 *  preserved, and the write is atomic (temp + rename) so a crash can't
 *  truncate the file. Best-effort: a malformed or unreadable config is left
 *  untouched and never blocks the launch. Headless `-p` runs skip the dialog
 *  already, so this is only needed for interactive launches. */
/** True when the Claude Code argv asks for stream-json output (both the
 *  `--output-format stream-json` and `--output-format=stream-json` forms).
 *  Combined with an inherited GIPITY_CONVERSATION_GUID this identifies a
 *  relay-daemon spawn, where the daemon owns capture and lifecycle-hook
 *  capture must stand down. Exported for tests. */
export function hasStreamJsonFlag(args: string[]): boolean {
  const idx = args.indexOf('--output-format');
  if (idx !== -1 && args[idx + 1] === 'stream-json') return true;
  return args.includes('--output-format=stream-json');
}

export function markFolderTrusted(dir: string): void {
  try {
    const file = join(homedir(), '.claude.json');
    const cfg: Record<string, any> = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf-8'))
      : {};
    if (typeof cfg !== 'object' || cfg === null) return;
    if (typeof cfg.projects !== 'object' || cfg.projects === null) cfg.projects = {};
    const entry: Record<string, any> =
      typeof cfg.projects[dir] === 'object' && cfg.projects[dir] !== null
        ? cfg.projects[dir]
        : {};
    if (entry.hasTrustDialogAccepted === true) return; // already trusted - no write
    entry.hasTrustDialogAccepted = true;
    cfg.projects[dir] = entry;
    const tmp = `${file}.gipity-tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, file);
  } catch {
    // A config-file hiccup must never block launching the agent.
  }
}

function suggestProjectName(existingSlugs: string[]): string {
  // Canonical format: `project-NNN` (3-digit, zero-padded, hyphenated).
  // Same shape the web "+ New Project" button uses, so both entry points
  // produce identical-looking projects.
  //
  // We scan for both the canonical `project-NNN` and the legacy `projectNN`
  // slugs so the suggested number stays monotonically ahead of whatever
  // already exists in the user's account.
  const slugSet = new Set(existingSlugs);
  let maxSeen = 0;
  for (const slug of existingSlugs) {
    const m = /^project-?(\d+)$/.exec(slug);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxSeen) maxSeen = n;
    }
  }
  const start = maxSeen + 1;
  for (let i = start; i <= 9999; i++) {
    const candidate = `project-${String(i).padStart(3, '0')}`;
    if (!slugSet.has(candidate)) return candidate;
  }
  return `project-${Date.now().toString(36).slice(-6)}`;
}

/** Both launch commands share one implementation: `gipity build` (the
 *  documented start-from-anywhere funnel: project picker + agent picker) and
 *  the hidden legacy `gipity claude` (identical behavior with the agent
 *  pinned to Claude and no agent question - kept
 *  working forever because deployed relay daemons and the GUI installer
 *  invoke it, but no longer advertised anywhere). */
function createLaunchCommand(name: string, cfg: { presetAgent?: string } = {}): Command {
  const cmd = new Command(name)
    .description(cfg.presetAgent ? 'Set up and run Claude Code (legacy alias of `gipity build`)' : 'Start building from anywhere - pick a project, pick your coding agent, go')
    .option('--setup-only', 'Do the Gipity setup but skip launching the agent')
    .option('--new-project', 'Create a fresh Gipity project instead of using cwd or the picker')
    .option('--name <name>', 'Name for --new-project (default: project-NNN)')
    .option('--project <slug>', 'Open an existing project by slug or id')
    .option('--here', 'Use the current directory instead of ~/GipityProjects/<slug>/')
    .option('--quiet', "Suppress the agent's live progress output (headless --new-project/--project runs)")
    // Forwarded to the agent via the unknown-arg passthrough below (NOT in the
    // gipity strip lists). Declared here only so it shows up in --help — without
    // this, callers can't discover that the session model is selectable.
    .option('--model <model>', 'Model for the session, passed straight to the agent (e.g. opus) - omit it and the agent uses its own default')
    .option('--bypass-approvals', 'Skip the agent\'s interactive tool approvals (headless runs; the relay daemon sets this)')
    .allowUnknownOption(true)
    .allowExcessArguments(true);
  if (!cfg.presetAgent) {
    cmd.option('--agent <agent>', `Which coding agent to launch: ${AGENT_KEYS.join(', ')} (default: your last-used)`);
  }
  cmd.action(async (opts) => { await runLaunch(name, cfg, opts); });
  return cmd;
}

export const buildCommand = createLaunchCommand('build');
export const claudeCommand = createLaunchCommand('claude', { presetAgent: 'claude' });

async function runLaunch(
  cmdName: string,
  cmdCfg: { presetAgent?: string },
  opts: any,
): Promise<void> {
    try {
      const runStart = Date.now();
      // Non-interactive passthrough: `gipity build -p "msg"` (and --print)
      // routes directly to the agent's headless mode after the normal setup
      // (auth, hooks, sync). Used by the relay daemon to dispatch messages
      // from the web CLI into a local agent session without a human at the
      // terminal. Requires an existing .gipity.json - we can't interactively
      // pick or create a project in this mode.
      const rawArgs = process.argv.slice(process.argv.indexOf(cmdName) + 1);

      // `gipity build install` - explicit, GUI-callable Claude Code install.
      // Handled here (leading positional) rather than as a Commander subcommand
      // because this command uses allowUnknownOption/allowExcessArguments to
      // pass everything through to the agent; a real subcommand would risk that
      // passthrough (which the relay daemon's headless dispatches depend on).
      if (rawArgs[0] === 'install') {
        const r = ensureClaudeInstalled({ force: rawArgs.includes('--force') });
        if (r.alreadyPresent) console.log(`  ${success('Claude Code already installed.')}`);
        else if (r.installed) console.log(`  ${success('Claude Code installed.')}`);
        else console.log(`  ${clrError('Could not install Claude Code.')} Install manually: npm install -g ${CLAUDE_PACKAGE}`);
        process.exit(r.installed ? 0 : 1);
      }

      const nonInteractive = rawArgs.some(a => a === '-p' || a === '--print' || a.startsWith('--print=') || a.startsWith('-p='));

      // Headless progress emitter: routes to stderr (stdout stays clean for
      // the child's result), drops the interactive 2-space indent, collapses
      // blank-line runs, and emits one leading blank to frame the block.
      const headlessOut = (() => {
        let started = false;
        let prevBlank = false;
        return (text: string): void => {
          for (const raw of String(text).split('\n')) {
            const line = raw.replace(/^[ \t]+/, '');
            const blank = line === '';
            if (!started) { process.stderr.write('\n'); started = true; prevBlank = true; }
            if (blank && prevBlank) continue;
            process.stderr.write(`${line}\n`);
            prevBlank = blank;
          }
        };
      })();

      // In non-interactive mode, all banner/progress output goes through the
      // headless emitter (stderr) so the child's stream-json stays clean.
      if (nonInteractive) {
        console.log = (...args: unknown[]) =>
          headlessOut(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
      }

      if (opts.newProject && opts.project) {
        console.error(`  ${clrError('Use --new-project or --project, not both.')}`);
        process.exit(1);
      }

      // ── Step 1: Auth ──────────────────────────────────────────────────
      let auth = getAuth();

      if (nonInteractive && !auth) {
        console.error(`  ${clrError('Not logged in. Run: gipity login')}`);
        process.exit(1);
      }
      if (nonInteractive && !getConfig() && !opts.newProject && !opts.project) {
        console.error(`  ${clrError('No Gipity project in cwd. Run `gipity build` (interactive) first, or pass --new-project / --project <slug>.')}`);
        process.exit(1);
      }

      if (!nonInteractive) {
        printBanner({ version: __clPkg.version ?? 'unknown', email: auth?.email, cwd: process.cwd() });
      }

      // A GIPITY_TOKEN env token authenticates every request on its own, so the
      // saved session's expiry is irrelevant when one is set — never re-login or
      // warn about expiry in that case.
      const hasEnvToken = Boolean(process.env.GIPITY_TOKEN?.trim());

      // Renew the access token UP FRONT so the login line we're about to print is
      // actually true — in BOTH interactive and headless/relay runs. A saved
      // session can look valid locally (refresh token not past its 7-day JWT
      // expiry, so sessionExpired() is false) yet be dead on the server: a sibling
      // process sharing this auth.json already consumed the single-use refresh
      // token (GipRunner and the relay run many gipity processes against one auth
      // dir), the user logged in elsewhere, or — in dev — the server's session
      // store was flushed/restarted. refreshTokenIfNeeded() round-trips to the
      // server and adopts any freshly-rotated token; if it fails, the access token
      // stays expired and accessTokenExpired() catches it below. Headless runs
      // USED to skip this and print "Logged in" off the cheap local check alone —
      // then the very next sync would 401 with "Session expired" and the relay
      // would run Claude anyway against a tree it could neither pull nor push.
      if (auth && !hasEnvToken && !sessionExpired()) {
        await refreshTokenIfNeeded();
        auth = getAuth();
      }

      // Re-login is genuinely required when the refresh token has lapsed, OR the
      // proactive renewal above could not produce a still-valid access token
      // (refresh token rejected — rotated away, revoked, or the server forgot it).
      // Checked identically for headless and interactive now: a dead session must
      // not silently proceed in either. Never triggered while a GIPITY_TOKEN env
      // token is supplying auth.
      const reloginRequired = auth != null && !hasEnvToken &&
        (sessionExpired() || accessTokenExpired());

      if (auth && reloginRequired && nonInteractive) {
        // Headless (relay dispatch, CI): we can't prompt for a re-login, and
        // running Claude now would work against a project tree we can neither pull
        // nor push (every authenticated call 401s). Fail fast with the actionable
        // message instead of printing "Logged in" and silently losing the user's
        // changes. The relay surfaces this stderr line to the web CLI as the
        // dispatch error, so the user sees "run: gipity login" instead of a run
        // that appeared to work but synced nothing.
        console.error(`  ${clrError('Your Gipity session has expired. Run: gipity login')}`);
        process.exit(1);
      }

      if (auth && reloginRequired) {
        // The saved session is dead (refresh token lapsed, or rotated away by a
        // sibling process), so the first API call below would 401. Re-login up
        // front instead of printing "Logged in" and immediately contradicting it
        // with "session expired" once the projects fetch fails.
        console.log(`  ${muted('Your session expired. Let\'s sign you back in.')}\n`);
        auth = await interactiveLogin();
      } else if (auth) {
        console.log(`  Logged in (${auth.email}).`);
      } else {
        console.log('  Let\'s get you logged in.\n');
        auth = await interactiveLogin();
      }

      console.log('');

      // ── Step 1b: Relay first-run onboarding (account-scoped, runs before project) ──
      if (!nonInteractive) {
        await maybeOfferRelayOn();
      }
      if (!nonInteractive && relayState.isRelayEnabled() && !relayState.isPaused()) {
        ensureDaemonRunning();
      }

      // ── Step 2: Project ───────────────────────────────────────────────
      let initialPrompt = '';
      let headlessNewProject = false;

      // One reporter for the (otherwise silent) sync phases + upload bar, so a
      // long sync of a large tree no longer reads as a hang. Stays silent in
      // headless (-p) runs to keep machine-readable output clean.
      const syncProgress = nonInteractive ? undefined : createProgressReporter();

      let existing = getConfig();
      let forceAdoptCwd = false;

      // Ambiguity guard: a `.gipity.json` inherited from an ANCESTOR directory
      // (cwd has none of its own) plus an empty cwd is genuinely ambiguous -
      // it could mean "work inside the parent project" or "start a new project
      // here". Ask, rather than silently adopting the parent. Flag-driven runs
      // (--project / --new-project) and headless (-p) runs are unambiguous.
      if (existing && !opts.newProject && !opts.project && !nonInteractive) {
        const cwdHasConfig = existsSync(resolve(process.cwd(), '.gipity.json'));
        if (!cwdHasConfig && isLikelyEmpty(process.cwd())) {
          const ancestorRoot = dirname(getConfigPath()!);
          console.log(`  ${bold('You are inside an existing Gipity project.')}\n`);
          console.log(`    ${bold('1.')} Continue in ${brand(existing.projectSlug)} ${muted(`(rooted at ${formatCwdLabel(ancestorRoot)})`)}`);
          console.log(`    ${bold('2.')} Create a new project here ${muted(`(${formatCwdLabel(process.cwd())})`)}`);
          console.log('');
          const choice = await pickOne('Choose', 2, 1);
          console.log('');
          if (choice === 2) {
            existing = null;
            forceAdoptCwd = true;
            clearConfigCache();
          }
        }
      }

      if (opts.newProject || opts.project) {
        // Flag-driven resolution: create or open a named project without the
        // interactive picker. Powers single-command runs such as
        // `gipity claude --new-project -p "..."` and `--project <slug> -p`.

        // Fetch the account's projects - needed to suggest/validate a name
        // for --new-project and to resolve the target for --project.
        let projects: ProjectData[];
        try {
          const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=1000');
          projects = res.data;
        } catch (err: any) {
          if (err instanceof ApiError && err.statusCode === 401) {
            // Don't clearAuth() — the file is shared with concurrent gipity
            // processes (sync hook, relay); deleting it logs them all out. A
            // re-login overwrites it anyway. Leave it and just point the user.
            console.error(`  ${clrError('Your session expired.')} ${muted('Run: gipity login')}`);
          } else {
            console.error(`  ${clrError(`Could not load projects: ${err?.message || err}`)}`);
          }
          process.exit(1);
          return;
        }
        const existingSlugs = projects.map(p => p.slug);

        let project: ProjectData;
        let isNewProject = false;

        if (opts.newProject) {
          const explicit = Boolean(opts.name);
          const presetName = explicit ? String(opts.name).trim() : suggestProjectName(existingSlugs);
          project = await createNewProject(existingSlugs, { name: presetName, explicit });
          isNewProject = true;
        } else {
          const target = String(opts.project);
          const found = projects.find(p => p.slug === target || p.short_guid === target);
          if (!found) {
            console.error(`  ${clrError(`No project matching "${target}".`)} ${muted('List projects with: gipity project')}`);
            process.exit(1);
            return;
          }
          project = found;
        }

        // Materialize the project directory, chdir in, write config, sync.
        // Default: ~/GipityProjects/<slug>/. With --here: the current dir.
        // For --project this pulls the server's files into that dir.
        const projectDir = opts.here ? process.cwd() : join(getProjectsRoot(), project.slug);
        mkdirSync(projectDir, { recursive: true });
        process.chdir(projectDir);
        clearConfigCache();

        let agentGuid = '';
        try {
          const agents = await get<{ data: AgentData[] }>(`/projects/${project.short_guid}/agents`);
          if (agents.data.length > 0) agentGuid = agents.data[0].short_guid;
        } catch { /* no agents */ }

        const accountSlug = await getAccountSlug();
        saveConfigAt(projectDir, {
          projectGuid: project.short_guid,
          projectSlug: project.slug,
          accountSlug,
          agentGuid,
          conversationGuid: null,
          apiBase: getApiBaseOverride() || DEFAULT_API_BASE,
          ignore: DEFAULT_SYNC_IGNORE,
        });

        console.log(`\n  Using ${projectDir}`);
        try {
          const result = await sync({ interactive: !nonInteractive, confirmMerge: !nonInteractive, progress: syncProgress });
          reportSyncResult(result);
        } catch (err) {
          console.log(`  ${warning('Could not sync files (will retry on next prompt):')} ${(err as Error).message}`);
        }

        setupProjectTools();
        if (!nonInteractive) console.log(`  ${muted('Installed Gipity plugin, skills, and hooks.')}`);

        if (nonInteractive) {
          // Headless: the -p message is wrapped later (Step 3). Just record
          // whether to use the new-project framing for that wrap.
          headlessNewProject = isNewProject;
        } else {
          // Interactive: launch with no seeded first message. The per-project
          // CLAUDE.md (refreshed just above) carries the project identity,
          // scaffold rule, and definition of done, so Claude has full context
          // the moment the user types. A welcome banner prints before launch.
          initialPrompt = '';
        }

        console.log(`  ${success(`Project "${project.name}" ready.`)}\n`);
      } else if (existing) {
        // cwd already has (or inherits) a .gipity.json - run inside it.
        console.log(`  Project: ${brand(existing.projectSlug)} ${muted(`(${existing.projectGuid})`)}`);
        console.log(`  ${success('Already set up.')}\n`);
        setupProjectTools();

        // Warn before syncing a very large project tree. An oversized root
        // (or a config accidentally rooted high up, e.g. at $HOME) makes the
        // sync slow, and a silent multi-GB walk reads as a hang.
        let doSync = true;
        const projectRoot = dirname(getConfigPath()!);
        const scan = scanForAdoption(projectRoot);
        if (scan.tier === 'refuse' && !nonInteractive) {
          const sizeStr = scan.truncated ? `>${formatBytes(ADOPT_THRESHOLDS.REFUSE_BYTES)}` : formatBytes(scan.bytes);
          const fileStr = scan.truncated ? `>${ADOPT_THRESHOLDS.REFUSE_FILES}` : `${scan.files}`;
          console.log(`  ${clrError(`Large project: ${fileStr} files (${sizeStr}) under ${formatCwdLabel(projectRoot)}.`)}`);
          console.log(`  ${muted('Syncing this many files with Gipity may be slow.')}`);
          doSync = await confirm('  Sync with Gipity now?', { default: 'yes' });
          console.log('');
        }

        if (doSync) {
          try {
            const result = await sync({ interactive: !nonInteractive, confirmMerge: !nonInteractive, progress: syncProgress });
            reportSyncResult(result);
          } catch (err) {
            console.log(`  ${warning('Could not sync files (will retry on next prompt):')} ${(err as Error).message}`);
          }
        }

        // Interactive: no seeded prompt - CLAUDE.md carries the context now.
        initialPrompt = '';
      } else {
        // Fetch user's projects. If the session expired (401), re-run the
        // interactive login and retry once - no reason to kick the user out
        // to a shell just to re-run the same command.
        let projects: ProjectData[] = [];
        let reauthed = false;
        // When the user already chose "create a new project here", skip the
        // project list entirely - we go straight to the adopt-cwd path.
        while (!forceAdoptCwd) {
          try {
            const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=1000');
            projects = res.data;
            break;
          } catch (err: any) {
            const isConnectionError = err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' ||
              err?.code === 'ETIMEDOUT' || err?.cause?.code === 'ECONNREFUSED' ||
              err?.cause?.code === 'ENOTFOUND' || err?.cause?.code === 'ETIMEDOUT';
            if (isConnectionError) {
              const apiBase = getApiBaseOverride() || DEFAULT_API_BASE;
              console.error(`  ${clrError(`Could not connect to ${apiBase}`)}`);
              console.error(`  ${muted('Check your connection and try again.')}`);
              process.exit(1);
            }
            if (err instanceof ApiError && err.statusCode === 401 && !reauthed && !nonInteractive) {
              // No clearAuth(): interactiveLogin() saves fresh tokens over the
              // file. Deleting it first would log out any sibling process (sync
              // hook, relay) sharing this ~/.gipity/auth.json mid-run.
              console.log(`  ${muted('Your session expired. Let\'s sign you back in.')}\n`);
              auth = await interactiveLogin();
              console.log('');
              reauthed = true;
              continue;
            }
            if (err instanceof ApiError && err.statusCode === 401) {
              // Leave the shared auth.json in place (see above) — just message.
              console.error(`  ${clrError('Your session expired.')}`);
              console.error(`  ${muted('Run: gipity login')}`);
              process.exit(1);
            }
            console.error(`  ${clrError(`Could not load projects: ${err?.message || err}`)}`);
            process.exit(1);
          }
        }

        const existingSlugs = projects.map(p => p.slug);
        let project: ProjectData;
        let isNewProject = false;
        let accountSlug = '';
        let agentGuid = '';

        const result = forceAdoptCwd
          ? { kind: 'adopt-cwd' as const }
          : projects.length > 0
            ? await pickOrCreateProject(projects, existingSlugs)
            : { kind: 'create-new' as const, project: await createNewProject(existingSlugs) };

        if (result.kind === 'adopt-cwd') {
          // User chose "Use this directory" - derive a slug from the cwd
          // basename, find-or-create the server project, write
          // .gipity.json into cwd (no projects-root materialization).
          const cwdBase = basename(process.cwd());
          const adoptSlug = slugify(cwdBase) || 'project';
          // Server caps name at 100 chars; clamp so a very long dir name
          // doesn't trip a "Too big" 400 (slugify already clamps the slug).
          const adoptName = (cwdBase || adoptSlug).slice(0, 100);
          accountSlug = await getAccountSlug();
          const adopted = await adoptCurrentDir({
            cwd: process.cwd(),
            projectName: adoptName,
            projectSlug: adoptSlug,
            accountSlug,
            confirmDeletions: !nonInteractive,
          });
          project = adopted.project;
          agentGuid = adopted.agentGuid;
          // Treat as "new project" for the build prompt only when cwd is
          // genuinely empty - otherwise the user has chosen to adopt
          // existing content and shouldn't be asked "what to build?".
          isNewProject = isLikelyEmpty(process.cwd());
          console.log(`\n  Using ${process.cwd()}`);
          if (adopted.applied > 0) {
            console.log(`  Synced ${adopted.applied} change${adopted.applied > 1 ? 's' : ''} with Gipity.`);
          }
        } else {
          project = result.project;
          isNewProject = result.kind === 'create-new';

          // Resolve project directory under ~/GipityProjects/{slug}
          const projectDir = join(getProjectsRoot(), project.slug);

          mkdirSync(projectDir, { recursive: true });
          process.chdir(projectDir);
          clearConfigCache();

          // Fetch agents
          try {
            const agents = await get<{ data: AgentData[] }>(`/projects/${project.short_guid}/agents`);
            if (agents.data.length > 0) agentGuid = agents.data[0].short_guid;
          } catch {
            // No agents
          }

          accountSlug = await getAccountSlug();

          // Always write config (refresh stale GUIDs from a previous setup)
          saveConfigAt(projectDir, {
            projectGuid: project.short_guid,
            projectSlug: project.slug,
            accountSlug,
            agentGuid,
            conversationGuid: null,
            apiBase: getApiBaseOverride() || DEFAULT_API_BASE,
            ignore: DEFAULT_SYNC_IGNORE,
          });

          console.log(`\n  Using ${projectDir}`);

          // Unified sync - push and pull resolved via three-way merge (non-fatal)
          try {
            const result = await sync({ interactive: !nonInteractive, confirmMerge: !nonInteractive, progress: syncProgress });
            reportSyncResult(result);
          } catch (err) {
            console.log(`  ${warning('Could not sync files (will retry on next prompt):')} ${(err as Error).message}`);
          }
        }

        // Interactive launch: no seeded first message (new or existing). The
        // per-project CLAUDE.md carries identity + scaffold rule + definition
        // of done, and a welcome banner prints before launch - the user tells
        // Claude directly what they want to build or do.
        initialPrompt = '';

        setupProjectTools();
        if (!nonInteractive) console.log(`  ${muted('Installed Gipity plugin, skills, and hooks.')}`);

        console.log(`  ${success(`Project "${project.name}" ready.`)}\n`);
      }

      // ── Step 3: Pick the coding agent + model ─────────────────────────
      if (opts.setupOnly) {
        console.log(`  Done. cd ${process.cwd()} && gipity ${cmdName}`);
        return;
      }

      const prefs = readPrefs();
      let agentKey = cmdCfg.presetAgent ?? (typeof opts.agent === 'string' ? opts.agent.toLowerCase() : undefined);
      if (agentKey && !AGENT_KEYS.includes(agentKey)) {
        console.error(`  ${clrError(`Unknown agent "${agentKey}".`)} ${muted(`Valid: ${AGENT_KEYS.join(', ')}`)}`);
        process.exit(1);
      }
      if (!agentKey) {
        if (nonInteractive) {
          // Headless never prompts: --agent, else last-used, else Claude.
          agentKey = prefs.lastAgent && AGENT_KEYS.includes(prefs.lastAgent) ? prefs.lastAgent : 'claude';
        } else {
          agentKey = await pickAgent(prefs.lastAgent);
        }
      }
      const adapter = getAdapter(agentKey);

      // The project's tool set was resolved above, before we knew which agent
      // the user would pick (the picker runs after). A project pinned to one
      // tool - or set up on a machine where this agent wasn't installed yet -
      // would otherwise launch this agent with no primer and no capture hooks.
      // Idempotent: a no-op when the agent is already part of the project.
      setupToolForAgent(adapter.key);

      // We never ask about the model: an explicit `--model` passes straight
      // through to the agent, and with no flag the agent's own default (and
      // its own model memory) stays authoritative. Only an interactive pick
      // is remembered (a daemon dispatch or the legacy `gipity claude` shim
      // must not clobber the user's agent memory).
      if (!nonInteractive && !cmdCfg.presetAgent) {
        writePrefs({ lastAgent: adapter.key });
      }

      // ── Step 4: Launch the agent ───────────────────────────────────────
      if (adapter.key !== 'claude') {
        await launchNonClaudeAgent(adapter, {
          cmdName, opts, rawArgs, nonInteractive, headlessOut, runStart,
        });
        return;
      }

      // Ensure Claude Code is installed - install it ourselves if missing so a
      // GUI/installer (and terminal users) get it for free, rather than being
      // told to run npm by hand.
      if (!isClaudeInstalled()) {
        console.log('  Claude Code not found - installing it now...');
        const r = ensureClaudeInstalled();
        if (!r.installed) {
          console.log(`  ${clrError('Could not install Claude Code.')} Install manually: npm install -g ${CLAUDE_PACKAGE}`);
          console.log(`  Then: cd ${process.cwd()} && claude`);
          return;
        }
        console.log(`  ${success('Claude Code installed.')}`);
      }

      // Ensure the Gipity plugin is actually installed at user scope (not just
      // enabled declaratively) so its capture + file-sync hooks load in this
      // run's cwd. No-ops once the current version is installed; best-effort.
      ensureGipityPluginInstalled();

      // Resolve (or create) the backing Gipity conversation for this
      // Claude Code run. The conv_guid is handed to the child (and thus
      // every capture hook spawned by Claude Code) via env var so every
      // capture event is explicitly tagged to the right conversation.
      //
      // Three paths:
      //   1. Inherited GIPITY_CONVERSATION_GUID - the relay daemon already
      //      created the conv and spawned us with it set. Just pass it
      //      through. Creating another would orphan the dispatch's conv.
      //   2. `--resume <sid>` - look up the existing conv by Claude Code
      //      session_id.
      //   3. Otherwise - create a fresh claude_code conv tied to this
      //      paired device.
      //
      // Skipped silently if this machine isn't paired - without a device
      // we can't satisfy the claude_code ownership rule, so hooks stay
      // offline for this run.
      //
      // Note: when this process was spawned BY the relay daemon (inherited
      // GIPITY_CONVERSATION_GUID) with `--output-format stream-json`, the
      // daemon is capturing Claude's stdout directly and hook-based capture
      // would double-post every event. In that case we set GIPITY_CAPTURE=off
      // on the Claude child (see childEnv assignment below) so the hook
      // runner stands down. A USER-supplied stream-json run has no daemon
      // behind it - hooks stay armed there, or the conversation would sit
      // empty forever (the qwen-flight zero-message bug, 2026-07-07).
      const inheritedConvGuid = Boolean(process.env.GIPITY_CONVERSATION_GUID);
      let convGuidForHooks: string | null = process.env.GIPITY_CONVERSATION_GUID ?? null;
      if (!convGuidForHooks) {
        const device = relayState.getDevice();
        if (device) {
          const cfg = getConfig();
          const resumeIdx = process.argv.indexOf('--resume');
          const resumeSid = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : null;
          try {
            if (resumeSid) {
              try {
                const found = await get<{ data: { conversation_guid: string } }>(
                  `/conversations/remote/by-session/${encodeURIComponent(resumeSid)}?source=claude_code`,
                );
                convGuidForHooks = found.data.conversation_guid;
              } catch {
                // No existing conv for this session id - fall through and
                // create one so capture still has a home.
              }
            }
            if (!convGuidForHooks && cfg?.projectGuid) {
              // A terminal launch is always origin='local' - marks the
              // conversation as a local-terminal chat so the web CLI renders
              // it read-only. Dispatch convs (created by the relay daemon
              // spawning headless runs) use the default 'dispatch'.
              const created = await post<{ data: { conversation_guid: string } }>(
                '/conversations/remote',
                { project_guid: cfg.projectGuid, device_guid: device.guid, source: 'claude_code', origin: 'local' },
              );
              convGuidForHooks = created.data.conversation_guid;
            }
          } catch (err: any) {
            if (!nonInteractive) {
              console.error(`  ${clrError(`Could not create Gipity conversation: ${err?.message || err}`)}`);
            }
          }
        }
      }

      // Pass through all unknown args to the agent (everything after the
      // command name). Gipity-level flags are stripped: boolean flags dropped
      // outright, value-bearing flags drop the flag and its value (both
      // `--f v` and `--f=v` forms).
      const cmdIdx = process.argv.indexOf(cmdName);
      const rawClaudeArgs = process.argv.slice(cmdIdx + 1);
      const gipityBooleanFlags = new Set(['--setup-only', '--new-project', '--here', '--quiet', '--bypass-approvals']);
      const gipityValueFlags = ['--api-base', '--name', '--project', '--agent'];
      const claudeArgs: string[] = [];
      for (let i = 0; i < rawClaudeArgs.length; i++) {
        const arg = rawClaudeArgs[i];
        if (gipityBooleanFlags.has(arg)) continue;
        if (gipityValueFlags.includes(arg)) { i++; continue; } // skip flag + its value
        if (gipityValueFlags.some(f => arg.startsWith(`${f}=`))) continue;
        claudeArgs.push(arg);
      }

      if (!nonInteractive) {
        console.log(`  ${bold('Launching Claude Code, powered by Gipity.')}`);
        if (convGuidForHooks) {
          console.log('');
          console.log(`  ${muted(`This session is saved to Gipity - watch it live at ${brand('prompt.gipity.ai')}. (--no-capture on init to disable.)`)}`);
        }
        console.log('');
      }

      // In non-interactive (-p) mode, prepend a Gipity preamble to the
      // user's raw message. Two flavors:
      //   - No --resume → full project context block (project name, files,
      //     deploy URL, decision flow). A fresh session has no prior context.
      //   - --resume → short framing line only. Claude already has the full
      //     context from the original start dispatch; we just remind it which
      //     project it's in and to use Gipity tools rather than freelance.
      let allArgs: string[];
      if (nonInteractive) {
        const hasResume = claudeArgs.includes('--resume');
        const pIdx = claudeArgs.findIndex(a => a === '-p' || a === '--print');
        if (pIdx !== -1 && pIdx + 1 < claudeArgs.length) {
          const config = getConfig();
          const userMsg = claudeArgs[pIdx + 1];
          let accountSlug = '';
          try { accountSlug = await getAccountSlug(); } catch { /* best effort */ }
          const ctxOpts: LocalCtxOpts = {
            projectName: config?.projectSlug ?? 'this project',
            projectSlug: config?.projectSlug ?? '',
            projectGuid: config?.projectGuid ?? '',
            accountSlug,
            cwd: process.cwd(),
          };
          let wrapped: string;
          if (headlessNewProject) {
            // Brand-new empty project - use the new-project framing so Claude
            // picks a template and scaffolds, with the -p message as the idea.
            const stats = await fetchProjectStats(ctxOpts.projectGuid, ctxOpts.cwd);
            wrapped = buildNewProjectPrompt({ ...ctxOpts, ...stats, buildIdea: userMsg });
          } else if (hasResume) {
            // Resume wrap only needs project identity (no file stats), so
            // skip the stats API call on every resumed message.
            wrapped = buildResumeWrap(ctxOpts, userMsg);
          } else {
            wrapped = buildFreshWrap(await buildProjectContextBlock(ctxOpts), userMsg);
          }
          allArgs = [...claudeArgs];
          allArgs[pIdx + 1] = wrapped;
          headlessOut(`\nSending to Claude Code: ${userMsg}\n`);
        } else {
          allArgs = claudeArgs;
        }
      } else {
        // Any `--model` the user passed is already in claudeArgs (passthrough);
        // with no flag Claude picks its own default.
        allArgs = initialPrompt ? [initialPrompt, ...claudeArgs] : claudeArgs;
      }

      // Single-command headless flows (`--new-project` / `--project` with -p)
      // have no human to approve tool use - auto-bypass so Claude can actually
      // execute. Same authority as the relay daemon spawning `gipity claude -p`.
      // Skipped if the user already set a permission flag themselves.
      if (nonInteractive && (opts.newProject || opts.project)) {
        const hasPermFlag = allArgs.some(a =>
          a === '--permission-mode' || a.startsWith('--permission-mode=') ||
          a === '--dangerously-skip-permissions');
        if (!hasPermFlag) allArgs.push('--permission-mode', 'bypassPermissions');
      }

      // Live progress: a human typed this single-command run, so stream
      // Claude's turn-by-turn output instead of going silent until the final
      // result. Scoped to --new-project/--project, so the relay daemon's own
      // invocation (which never sets those) is unaffected. Skipped if the user
      // opted out (--quiet) or already chose their own verbosity / format.
      if (nonInteractive && (opts.newProject || opts.project) && !opts.quiet) {
        if (!allArgs.includes('--verbose') && !allArgs.includes('--output-format')) {
          allArgs.push('--verbose');
        }
      }

      // Resolve the real path on Windows; spawnCommand then routes the `.cmd`
      // shim through cmd.exe with verbatim args (a bare `spawn` of a `.cmd`
      // throws EINVAL on Node >=18.20.2/20.12.2 - the CVE-2024-27980 fix).
      const claudeCmd = resolveCommand('claude');
      const childEnv = { ...process.env };
      // Gate hook-based capture: only when the DAEMON is streaming via
      // --output-format stream-json (inherited guid = daemon spawn) does it
      // own the capture; any hook post would then be a dupe. GIPITY_CAPTURE=off
      // stands the hook runner down explicitly - merely unsetting the guid is
      // no longer enough now that the runner self-arms from .gipity.json.
      // A user-supplied stream-json run (no inherited guid) keeps hooks armed.
      const daemonCapturing = inheritedConvGuid && hasStreamJsonFlag(allArgs);
      if (daemonCapturing) {
        delete childEnv.GIPITY_CONVERSATION_GUID;
        childEnv.GIPITY_CAPTURE = 'off';
      } else if (convGuidForHooks) {
        childEnv.GIPITY_CONVERSATION_GUID = convGuidForHooks;
      }
      // A Gipity project directory is trusted by construction - the user
      // created or explicitly chose it. Pre-accept Claude's per-directory
      // trust dialog so an interactive launch doesn't stop to ask. Headless
      // `-p` runs skip the dialog already, so this is only needed interactively.
      if (!nonInteractive) markFolderTrusted(process.cwd());

      const child = spawnCommand(claudeCmd, allArgs, {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: childEnv,
      });
      // A spawn failure (missing/non-executable binary) arrives asynchronously via
      // 'error', which the surrounding try/catch can't catch - without this handler
      // Node crashes with a raw stack trace. claude is normally installed above, so
      // this is a defensive fallback.
      child.on('error', (err: NodeJS.ErrnoException) => {
        console.error(`\n  ${clrError(err.code === 'ENOENT'
          ? `Claude Code not found. Install it: npm install -g ${CLAUDE_PACKAGE}`
          : `Failed to launch Claude Code: ${err.message}`)}`);
        process.exit(1);
      });
      child.on('exit', (code) => {
        const doneLine = `Done (${formatElapsed(Date.now() - runStart)})`;
        if (nonInteractive) process.stderr.write(`\n${doneLine}\n\n`);
        else {
          console.log(`\n  ${doneLine}`);
          // Both continue paths are first-class - user preference, not a hierarchy.
          console.log(`  ${muted(`Next time: gipity build from anywhere, or cd ${process.cwd()} && claude.`)}`);
        }
        process.exit(code ?? 0);
      });

    } catch (err: any) {
      console.error(`\n  ${clrError(`Error: ${err.message}`)}`);
      process.exit(1);
    }
}

// ─── Agent picker ─────────────────────────────────────────────────────────
// Same pick-a-number-or-hit-enter format as the project picker. Only agents
// actually found on PATH are numbered choices; the rest are named in a
// footnote as supported-but-not-detected, not offered as pickable slots.
// The enter-enter path must stay the visibly obvious one: the default agent
// is the last-used one (else the first detected agent). We deliberately
// don't ask about the model - the agent's own default is always right and a
// curated list only rots.

async function pickAgent(lastUsed: string | undefined): Promise<string> {
  const detected = AGENT_ADAPTERS.filter(a => binaryOnPath(a.binary));
  // Nothing detected (fresh machine, nothing installed yet): fall back to
  // the full list so there's still something to pick - selecting one drives
  // the existing auto-install/install-hint path below.
  const listed = detected.length ? detected : AGENT_ADAPTERS;
  const undetected = AGENT_ADAPTERS.filter(a => !listed.includes(a));

  const defaultKey = lastUsed && listed.some(a => a.key === lastUsed) ? lastUsed : listed[0].key;
  const defaultIdx = listed.findIndex(a => a.key === defaultKey) + 1;
  console.log(`  ${bold('Which coding agent?')}\n`);
  listed.forEach((a, i) => {
    const notes: string[] = [];
    if (a.key === lastUsed) notes.push('last used');
    if (!a.hooksSupportedOnPlatform(process.platform)) {
      notes.push('session recording unavailable on Windows');
    }
    const note = notes.length ? `  ${muted(`(${notes.join(', ')})`)}` : '';
    console.log(`    ${bold(`${i + 1}.`)} ${a.displayName} ${muted(`(${a.providerName})`)}${note}`);
  });
  if (undetected.length) {
    const names = undetected.map(a => a.displayName).join(', ');
    console.log(`  ${muted(`Also supported (not detected on this machine): ${names} - use --agent <name>`)}`);
  } else if (!detected.length) {
    console.log(`  ${muted('None detected on this machine - picking one installs it.')}`);
  }
  console.log('');
  const choice = await pickOne('Choose', listed.length, defaultIdx);
  console.log('');
  return listed[choice - 1].key;
}

// ─── Non-Claude agent launch (Codex, Grok) ────────────────────────────────
// The Claude path above carries years of Claude-specific plumbing (plugin
// install, folder trust, stream-json capture gating, -p context wrapping).
// Other agents launch simpler: their project integration (skills, hooks,
// AGENTS.md) was installed by setupProjectTools() during the project step,
// and session capture rides those hooks - INCLUDING for relay dispatches
// (there is no stream-json ingest path for them, so GIPITY_CAPTURE is never
// turned off here).
async function launchNonClaudeAgent(adapter: RemoteAgentAdapter, ctx: {
  cmdName: string;
  opts: any;
  rawArgs: string[];
  nonInteractive: boolean;
  headlessOut: (text: string) => void;
  runStart: number;
}): Promise<void> {
  const { opts, rawArgs, nonInteractive, headlessOut, runStart } = ctx;

  // ── Binary ──────────────────────────────────────────────────────────────
  if (!binaryOnPath(adapter.binary)) {
    let installed = false;
    if (adapter.ensureInstalled) {
      console.log(`  ${adapter.displayName} not found - installing it now...`);
      installed = adapter.ensureInstalled();
    }
    if (!installed && !binaryOnPath(adapter.binary)) {
      console.error(`  ${clrError(`${adapter.displayName} is not installed.`)} Install it with: ${adapter.installHint}`);
      console.error(`  ${muted(`Then run: gipity ${ctx.cmdName} --agent ${adapter.key}`)}`);
      process.exit(1);
    }
  }

  // ── Gipity-level flag strip + agent-flag extraction ────────────────────
  // Same strip contract as the Claude path, plus extraction of the flags the
  // adapter translates (-p message, --model, --resume): Codex's headless form
  // is `codex exec …`, not `-p`, so these can't pass through verbatim.
  const booleanFlags = new Set(['--setup-only', '--new-project', '--here', '--quiet', '--bypass-approvals']);
  const valueFlags = ['--api-base', '--name', '--project', '--agent'];
  let message: string | null = null;
  let resume: string | undefined;
  let model: string | undefined;
  const extras: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (booleanFlags.has(arg)) continue;
    if (valueFlags.includes(arg)) { i++; continue; }
    if (valueFlags.some(f => arg.startsWith(`${f}=`))) continue;
    if (arg === '-p' || arg === '--print') { message = rawArgs[++i] ?? ''; continue; }
    if (arg.startsWith('-p=') || arg.startsWith('--print=')) { message = arg.slice(arg.indexOf('=') + 1); continue; }
    if (arg === '--model') { model = rawArgs[++i]; continue; }
    if (arg.startsWith('--model=')) { model = arg.slice('--model='.length); continue; }
    if (arg === '--resume') { resume = rawArgs[++i]; continue; }
    if (arg.startsWith('--resume=')) { resume = arg.slice('--resume='.length); continue; }
    extras.push(arg);
  }

  // ── Conversation binding (session recording) ────────────────────────────
  // Same three paths as Claude: inherited guid (daemon dispatch), resume
  // lookup by session id, else create fresh. Hook capture posts the actual
  // transcript - the env var just pins which conversation it lands in.
  let convGuid: string | null = process.env.GIPITY_CONVERSATION_GUID ?? null;
  if (!convGuid) {
    const device = relayState.getDevice();
    const config = getConfig();
    if (device && config?.projectGuid) {
      try {
        if (resume) {
          try {
            const found = await get<{ data: { conversation_guid: string } }>(
              `/conversations/remote/by-session/${encodeURIComponent(resume)}?source=${encodeURIComponent(adapter.source)}`,
            );
            convGuid = found.data.conversation_guid;
          } catch { /* no existing conv - create below */ }
        }
        if (!convGuid) {
          const created = await post<{ data: { conversation_guid: string } }>(
            '/conversations/remote',
            { project_guid: config.projectGuid, device_guid: device.guid, source: adapter.source, origin: 'local' },
          );
          convGuid = created.data.conversation_guid;
        }
      } catch (err: any) {
        if (!nonInteractive) {
          console.error(`  ${clrError(`Could not create Gipity conversation: ${err?.message || err}`)}`);
        }
      }
    }
  }

  // ── argv ────────────────────────────────────────────────────────────────
  let agentArgs: string[];
  let syntheticSid: string | null = null;
  if (nonInteractive) {
    // Headless one-shots auto-bypass approvals when there's no human at the
    // terminal to click "approve" (single-command runs and relay dispatches)
    // unless the caller opted out by... passing nothing. Mirrors the Claude
    // path's --permission-mode auto-append.
    const bypass = Boolean(opts.bypassApprovals || opts.newProject || opts.project);
    agentArgs = [
      ...adapter.buildHeadlessArgs({ message: message ?? '', resume, model, bypassApprovals: bypass, jsonStream: false }),
      ...extras,
    ];
    // Agents that fire no hooks headless (Grok) get launcher-driven capture:
    // pin the session id now, replay the transcript after the run.
    if (adapter.headlessCapture) {
      syntheticSid = resume ?? randomUUID();
      if (!resume) agentArgs.push(...adapter.headlessCapture.sessionIdArgs(syntheticSid));
    }
    if (message) headlessOut(`\nSending to ${adapter.displayName}: ${message}\n`);
  } else {
    agentArgs = [...adapter.buildInteractiveArgs({ resume, model }), ...extras];
    console.log(`  ${bold(`Launching ${adapter.displayName}, powered by Gipity.`)}`);
    if (convGuid) {
      console.log('');
      console.log(`  ${muted(`This session is saved to Gipity - watch it live at ${brand('prompt.gipity.ai')}. (--no-capture on init to disable.)`)}`);
    }
    if (adapter.oneTimeSetupNote) {
      console.log(`  ${warning(adapter.oneTimeSetupNote)}`);
    }
    console.log('');
  }

  // ── Spawn ───────────────────────────────────────────────────────────────
  // Async pre-spawn setup (e.g. opencode's model-slot token mint). Best-effort:
  // the agent must still launch when offline or logged out.
  if (adapter.prepareLaunch) {
    try { await adapter.prepareLaunch(); } catch { /* never block the launch */ }
  }
  const childEnv = { ...process.env };
  if (convGuid) childEnv.GIPITY_CONVERSATION_GUID = convGuid;

  const agentCmd = resolveCommand(adapter.binary);
  const child = spawnCommand(agentCmd, agentArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: childEnv,
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`\n  ${clrError(err.code === 'ENOENT'
      ? `${adapter.displayName} not found. Install it: ${adapter.installHint}`
      : `Failed to launch ${adapter.displayName}: ${err.message}`)}`);
    process.exit(1);
  });
  child.on('exit', (code) => {
    // Launcher-driven capture for hookless headless runs: replay the agent's
    // on-disk transcript through the capture runner as a synthetic
    // session-start + stop. Best-effort and flushed even on a nonzero exit -
    // whatever the agent got done should still show in the web CLI.
    if (syntheticSid && convGuid) {
      flushHeadlessCapture(adapter, syntheticSid, convGuid);
    }
    const doneLine = `Done (${formatElapsed(Date.now() - runStart)})`;
    if (nonInteractive) process.stderr.write(`\n${doneLine}\n\n`);
    else {
      console.log(`\n  ${doneLine}`);
      console.log(`  ${muted(`Next time: gipity build from anywhere, or cd ${process.cwd()} && ${adapter.binary}.`)}`);
    }
    process.exit(code ?? 0);
  });
}

/** Synchronously replay a finished headless session's transcript into the
 *  conversation via the capture runner (which owns parsing, image rewrite,
 *  ingest batching, watermark state, and session attach). Synchronous on
 *  purpose: it runs inside the child-exit handler, and the process exits
 *  right after - a fire-and-forget async spawn would be killed mid-flush. */
function flushHeadlessCapture(adapter: RemoteAgentAdapter, sessionId: string, convGuid: string): void {
  const runner = join(__clDir, '..', 'hooks', 'capture-runner.js');
  if (!existsSync(runner)) return;
  const payload = JSON.stringify({ session_id: sessionId, cwd: process.cwd() });
  const env = { ...process.env, GIPITY_CONVERSATION_GUID: convGuid };
  for (const event of ['session-start', 'stop']) {
    try {
      spawnSyncCommand(process.execPath, [runner, adapter.key, event], {
        input: payload, env, timeout: 60_000, stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch { /* capture is best-effort - never break the run */ }
  }
}

type PickResult =
  | { kind: 'pick'; project: ProjectData }
  | { kind: 'create-new'; project: ProjectData }
  | { kind: 'adopt-cwd' };

async function pickOrCreateProject(
  projects: ProjectData[],
  existingSlugs: string[],
): Promise<PickResult> {
  const filtered = projects.filter(p => !p.is_default);
  const cwd = process.cwd();
  const showAdopt = canAdoptCwd(cwd);

  // Reserve slot 1 for "create new", slot 2 for "use this dir" when shown.
  const reserved = showAdopt ? 2 : 1;
  // Pickable single-keypress range is 1-9. When every project fits, list
  // them all; otherwise the actions grow a "Search projects" slot right
  // after the reserved ones and "Show more" takes slot 9 - accounts with
  // hundreds of projects can't scroll a dump. Action rows render in a
  // different color than project rows so the two groups read apart.
  const fitsAll = filtered.length <= 9 - reserved;
  const hasMore = !fitsAll;
  const searchSlot = hasMore ? reserved + 1 : 0;
  const projectBase = reserved + (hasMore ? 1 : 0); // slots projectBase+1.. are projects
  const recent = fitsAll ? filtered : filtered.slice(0, 9 - reserved - 2);
  const moreSlot = hasMore ? projectBase + recent.length + 1 : 0; // always 9 when shown

  // Loop so that a refused/declined adopt-cwd re-shows the picker rather
  // than dropping the user into a shell.
  while (true) {
    const newProjectLabel = formatNewProjectLabel(existingSlugs);
    console.log(`  ${bold('Choose project to open:')}\n`);
    console.log(`    ${bold('1.')} ${info('Create new project')}          ${muted(`(${newProjectLabel})`)}`);
    if (showAdopt) {
      console.log(`    ${bold('2.')} ${info('Use this directory')}          ${muted(`(${formatCwdLabel(cwd)})`)}`);
    }
    if (hasMore) {
      console.log(`    ${bold(`${searchSlot}.`)} ${info('Search projects')} ${muted(`(${filtered.length} total)`)}`);
    }
    recent.forEach((p, i) =>
      console.log(`    ${bold(`${projectBase + i + 1}.`)} ${p.name} ${muted(`(${p.slug})`)}`),
    );
    if (hasMore) {
      console.log(`    ${bold(`${moreSlot}.`)} ${info('Show more')}`);
    }
    console.log('');

    const maxOption = projectBase + recent.length + (hasMore ? 1 : 0);
    const idx = await pickOne('Choose', maxOption, 1);

    // Recent project (slots projectBase+1 .. projectBase+recent.length).
    if (idx > projectBase && idx <= projectBase + recent.length) {
      return { kind: 'pick', project: recent[idx - projectBase - 1] };
    }

    // Search (right after the reserved slots) / Show more (slot 9).
    if (hasMore && (idx === searchSlot || idx === moreSlot)) {
      const picked = await browseProjects(filtered, { search: idx === searchSlot });
      if (picked) return { kind: 'pick', project: picked };
      console.log('');
      continue; // user backed out; re-show top picker
    }

    // Slot 2 = "Use this directory" (only when shown).
    if (showAdopt && idx === 2) {
      const ok = await confirmAdoptCwd(cwd);
      if (!ok) { console.log(''); continue; }
      return { kind: 'adopt-cwd' };
    }

    // Default (Enter) or slot 1 = create new project.
    const project = await createNewProject(existingSlugs);
    return { kind: 'create-new', project };
  }
}

const PROJECT_PAGE_SIZE = 10;

/** Case-insensitive substring match on project name or slug. An empty or
 *  whitespace-only query matches everything. Exported for tests. */
export function searchProjects(all: ProjectData[], query: string): ProjectData[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter(p => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
}

/** Paged, searchable project list - the shared renderer behind both the
 *  "Search projects" and "Show more" picker slots. Shows PROJECT_PAGE_SIZE
 *  rows at a time with numbering that stays stable across pages, then reads
 *  a full line (not single-keypress - numbers can exceed 9):
 *    Enter → next page · <number> → open that project
 *    s → new search (always over the FULL list, never the current subset)
 *    q → back to the main picker (returns null).
 *  `opts.search` starts by prompting for a query instead of listing all.
 *  Exported for tests. */
export async function browseProjects(
  all: ProjectData[],
  opts: { search?: boolean } = {},
): Promise<ProjectData | null> {
  let items = all;
  let heading = 'All projects';

  // Prompt for a query and swap the working list to the matches. Returns
  // false (list unchanged) on empty input or zero matches.
  const runSearch = async (): Promise<boolean> => {
    const q = await prompt(`  ${bold('Search projects:')} `);
    if (!q) return false;
    const matches = searchProjects(all, q);
    if (matches.length === 0) {
      console.log(`  ${muted(`No projects match "${q}".`)}`);
      return false;
    }
    items = matches;
    heading = `Projects matching "${q}"`;
    return true;
  };

  console.log('');
  if (opts.search && !(await runSearch())) return null;

  let shown = 0;
  while (true) {
    if (shown < items.length) {
      const page = items.slice(shown, shown + PROJECT_PAGE_SIZE);
      if (shown === 0) console.log(`  ${bold(`${heading}`)} ${muted(`(${items.length})`)}\n`);
      page.forEach((p, i) =>
        console.log(`    ${bold(`${String(shown + i + 1).padStart(3)}.`)} ${p.name} ${muted(`(${p.slug})`)}`),
      );
      shown += page.length;
      console.log('');
    }
    const more = shown < items.length;
    const hints = [
      more ? `Enter = next ${Math.min(PROJECT_PAGE_SIZE, items.length - shown)}` : null,
      'number = open',
      's = search',
      'q = back',
    ].filter(Boolean).join(' · ');
    const answer = (await prompt(`  ${bold('Choose')} ${muted(`(${hints})`)}: `)).toLowerCase();

    if (answer === '' && more) continue; // Enter → next page
    if (answer === '' || answer === 'q') return null;
    if (answer === 's') {
      if (await runSearch()) { shown = 0; console.log(''); }
      continue;
    }
    const n = parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= shown) return items[n - 1];
    console.log(`  ${muted('Type one of the numbers above, Enter for more, s to search, or q to go back.')}`);
  }
}

/** Show "(~/GipityProjects/project-NNN)" - the exact dir option 1 will
 *  create, so the user can see where their new project will land. */
function formatNewProjectLabel(existingSlugs: string[]): string {
  const slug = suggestProjectName(existingSlugs);
  const root = getProjectsRoot();
  const home = homedir();
  const display = root === home || root.startsWith(home + sep)
    ? '~' + root.slice(home.length)
    : root;
  return `${display}${sep}${slug}`;
}

/** Run the size-tier scan, surface the right UX:
 *    - easy   → silent, return true.
 *    - moderate → confirm prompt with file count + size.
 *    - refuse → print explanation, return false (caller re-shows picker).
 *  Returns true if adoption should proceed. */
async function confirmAdoptCwd(cwd: string): Promise<boolean> {
  process.stdout.write(`  ${muted('Scanning directory...')} `);
  const scan = scanForAdoption(cwd);
  process.stdout.write('\r\x1b[K'); // clear the scanning line

  if (scan.tier === 'refuse') {
    const sizeStr = scan.truncated ? `>${formatBytes(ADOPT_THRESHOLDS.REFUSE_BYTES)}` : formatBytes(scan.bytes);
    const fileStr = scan.truncated ? `>${ADOPT_THRESHOLDS.REFUSE_FILES}` : `${scan.files}`;
    console.log(`  ${clrError(`Directory has ${fileStr} files (${sizeStr}) - too large to adopt as a Gipity project.`)}`);
    console.log(`  ${muted('Move into a subdirectory, or use option 1 to create a fresh project under ~/GipityProjects/.')}`);
    console.log('');
    return false;
  }

  if (scan.tier === 'moderate') {
    console.log('');
    return confirm(
      `  About to adopt ${bold(String(scan.files))} files (${bold(formatBytes(scan.bytes))}) at ${bold(formatCwdLabel(cwd))}. Continue?`,
      { default: 'yes' },
    );
  }

  return true;
}

async function createNewProject(
  existingSlugs: string[],
  preset?: { name: string; explicit: boolean },
): Promise<ProjectData> {
  const taken = new Set(existingSlugs);
  let suggested = suggestProjectName(existingSlugs);
  console.log('');

  // Loop until the user picks a free, well-formed name. Bad input or duplicate
  // slugs re-prompt instead of crashing - duplicates can still slip through
  // after the initial projects-list fetch (race with another session), so the
  // server-side 409 also routes back here.
  //
  // `preset` drives the headless path (no human at the terminal):
  //   - explicit (--name X) → a clash fails loudly, never silently renames.
  //   - non-explicit (suggested project-NNN) → a clash bumps to the next
  //     number and retries, same as the interactive default.
  while (true) {
    let projectName: string;
    if (preset) {
      projectName = preset.explicit ? preset.name : suggested;
    } else {
      const name = await prompt(`  ${bold('Project name')} [${bold(suggested)}]: `);
      projectName = name || suggested;
    }
    const projectSlug = slugify(projectName);

    if (!projectSlug) {
      console.error(`  ${clrError('Invalid project name. Use letters, numbers, and hyphens.')}`);
      if (preset) process.exit(1);
      continue;
    }
    if (taken.has(projectSlug)) {
      console.error(`  ${clrError(`"${projectSlug}" already exists. Pick a different name.`)}`);
      if (preset?.explicit) process.exit(1);
      suggested = suggestProjectName([...taken]);
      continue;
    }

    try {
      // No autoChat here: the agent isn't chosen yet (the picker runs after
      // project setup), so a pre-created chat would guess `claude_code` and
      // sit empty forever whenever the user picks another agent. The launch
      // path creates (or the placeholder-reuse logic finds) the conversation
      // with the RIGHT source moments later.
      const body: { name: string; slug: string } = { name: projectName, slug: projectSlug };
      const res = await post<{ data: ProjectData }>('/projects', body);
      // Single console.log keeps the line on the headless stderr stream -
      // process.stdout.write would leak the message onto the child's stdout.
      console.log(`  ${info(`Creating "${projectName}"...`)} ${success('Created.')}`);
      return res.data;
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        console.error(`  ${clrError(`"${projectSlug}" was just taken. Pick a different name.`)}`);
        if (preset?.explicit) process.exit(1);
        taken.add(projectSlug);
        suggested = suggestProjectName([...taken]);
        continue;
      }
      throw err;
    }
  }
}


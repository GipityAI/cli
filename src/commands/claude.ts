import { Command } from 'commander';
import { join, dirname, resolve, basename } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

/** On Windows, spawn without shell:true needs an explicit extension (.exe or .cmd) */
function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  try {
    const lines = execSync(`where ${cmd}`, { encoding: 'utf-8' }).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Prefer .exe (native) over .cmd (npm shim)
    return lines.find(l => l.endsWith('.exe')) || lines.find(l => l.endsWith('.cmd')) || cmd;
  } catch {
    return `${cmd}.cmd`;
  }
}
import { getAuth, saveAuth, clearAuth, type AuthData } from '../auth.js';
import { get, post, publicPost, ApiError, getAccountSlug } from '../api.js';
import { getConfig, saveConfigAt, clearConfigCache, getApiBaseOverride, DEFAULT_API_BASE, getConfigPath } from '../config.js';
import { sync } from '../sync.js';
import { slugify, setupClaudeHooks, ensureGipityPluginInstalled, setupClaudeMd, setupAgentsMd, setupGitignore, DEFAULT_SYNC_IGNORE, isSyncIgnored } from '../setup.js';
import {
  buildProjectContextBlock as buildProjectContextBlockText,
  buildNewProjectPrompt,
  buildResumeWrap,
  buildFreshWrap,
} from '../prompts.js';
import * as relayState from '../relay/state.js';
import { maybeOfferRelayOn, ensureDaemonRunning } from '../relay/onboarding.js';
import { prompt, promptBoxed, pickOne, decodeJwtExp, confirm } from '../utils.js';
import { brand, bold, faint, info, success, error as clrError, muted } from '../colors.js';
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

const __clDir = dirname(fileURLToPath(import.meta.url));
const __clPkg = JSON.parse(readFileSync(resolve(__clDir, '../../package.json'), 'utf-8'));

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
async function fetchProjectStats(projectGuid: string, cwd: string): Promise<ProjectStats> {
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
    ? topLevelEntries.slice(0, 20).join(', ') + (topLevelEntries.length > 20 ? ', …' : '')
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

/** Interactive email+code login flow. Used on first login and when the
 *  server returns 401 mid-command (session expired). Writes the new auth
 *  to disk and returns it. */
async function interactiveLogin(): Promise<AuthData> {
  const email = await prompt('  Email: ');
  if (!email) { console.error(`\n  ${clrError('Email required.')}`); process.exit(1); }

  await publicPost('/auth/login', { email });
  console.log('  Check your email for a 6-digit code.\n');

  const code = await prompt('  Code: ');
  if (!code) { console.error(`\n  ${clrError('Code required.')}`); process.exit(1); }

  const res = await publicPost<{
    accessToken: string;
    refreshToken: string;
    isNewUser: boolean;
  }>('/auth/verify', { email, code });

  const exp = decodeJwtExp(res.accessToken);
  if (!exp) { console.error(`\n  ${clrError('Invalid token received.')}`); process.exit(1); }
  const expiresAt = new Date(exp * 1000).toISOString();

  saveAuth({ accessToken: res.accessToken, refreshToken: res.refreshToken, email, expiresAt });
  console.log(`  ${success(`Logged in (${email}).`)}`);
  return getAuth()!;
}

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

export const claudeCommand = new Command('claude')
  .description('Set up and run Claude Code')
  .option('--setup-only', 'Do the Gipity setup but skip launching the agent')
  .option('--new-project', 'Create a fresh Gipity project instead of using cwd or the picker')
  .option('--name <name>', 'Name for --new-project (default: project-NNN)')
  .option('--project <slug>', 'Open an existing project by slug or id')
  .option('--here', 'Use the current directory instead of ~/GipityProjects/<slug>/')
  .option('--quiet', "Suppress Claude's live progress output (headless --new-project/--project runs)")
  // Forwarded to `claude` via the unknown-arg passthrough below (NOT in the
  // gipity strip lists). Declared here only so it shows up in --help — without
  // this, callers can't discover that the session model is selectable.
  .option('--model <model>', 'Model for the Claude session, forwarded to claude (e.g. sonnet, opus, or a full id like claude-sonnet-4-6)')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (opts) => {
    try {
      const runStart = Date.now();
      // Non-interactive passthrough: `gipity claude -p "msg"` (and --print)
      // route directly to `claude -p` after the normal setup (auth, hooks,
      // sync). Used by the upcoming `gipity relay` daemon to dispatch
      // messages from the web CLI into a local Claude Code session without
      // a human at the terminal. Requires an existing .gipity.json - we
      // can't interactively pick or create a project in this mode.
      const rawArgs = process.argv.slice(process.argv.indexOf('claude') + 1);
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
        console.error(`  ${clrError('No Gipity project in cwd. Run `gipity claude` (interactive) first, or pass --new-project / --project <slug>.')}`);
        process.exit(1);
      }

      if (!nonInteractive) {
        printBanner({ version: __clPkg.version, email: auth?.email, cwd: process.cwd() });
      }

      if (auth) {
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
            clearAuth();
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
          const result = await sync({ interactive: !nonInteractive, progress: syncProgress });
          if (result.applied > 0) {
            console.log(`  Synced ${result.applied} change${result.applied > 1 ? 's' : ''} with Gipity.`);
          }
        } catch {
          console.log('  Could not sync files (will retry on next prompt).');
        }

        setupClaudeHooks();
        setupClaudeMd();
        setupAgentsMd();
        setupGitignore();

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
        setupClaudeHooks();
        setupClaudeMd();
        setupAgentsMd();
        setupGitignore();

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
            const result = await sync({ interactive: !nonInteractive, progress: syncProgress });
            if (result.applied > 0) {
              console.log(`  Synced ${result.applied} change${result.applied > 1 ? 's' : ''} with Gipity.`);
            }
          } catch {
            console.log('  Could not sync files (will retry on next prompt).');
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
              clearAuth();
              console.log(`  ${muted('Your session expired. Let\'s sign you back in.')}\n`);
              auth = await interactiveLogin();
              console.log('');
              reauthed = true;
              continue;
            }
            if (err instanceof ApiError && err.statusCode === 401) {
              clearAuth();
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
            const result = await sync({ interactive: !nonInteractive, progress: syncProgress });
            if (result.applied > 0) {
              console.log(`  Synced ${result.applied} change${result.applied > 1 ? 's' : ''} with Gipity.`);
            }
          } catch {
            console.log('  Could not sync files (will retry on next prompt).');
          }
        }

        // Interactive launch: no seeded first message (new or existing). The
        // per-project CLAUDE.md carries identity + scaffold rule + definition
        // of done, and a welcome banner prints before launch - the user tells
        // Claude directly what they want to build or do.
        initialPrompt = '';

        setupClaudeHooks();
        setupClaudeMd();
        setupAgentsMd();
        setupGitignore();

        console.log(`  ${success(`Project "${project.name}" ready.`)}\n`);
      }

      // ── Step 3: Launch Claude Code ────────────────────────────────────
      if (opts.setupOnly) {
        console.log(`  Done. cd ${process.cwd()} && gipity claude`);
        return;
      }

      // Check claude is installed
      try {
        const checkCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
        execSync(checkCmd, { stdio: 'ignore' });
      } catch {
        console.log('  Claude Code not found. Install it: npm install -g @anthropic-ai/claude-code');
        console.log(`  Then: cd ${process.cwd()} && claude`);
        return;
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
      // Note: when `--output-format stream-json` is present in argv, the
      // relay daemon is capturing Claude's stdout directly and the hook-
      // based transcript capture would double-post every event. In that
      // case we intentionally do NOT propagate GIPITY_CONVERSATION_GUID
      // to the Claude child (see childEnv assignment below) - the hook's
      // existing "no guid → silent no-op" guard then skips capture.
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
                  `/conversations/claude-code/by-session/${encodeURIComponent(resumeSid)}`,
                );
                convGuidForHooks = found.data.conversation_guid;
              } catch {
                // No existing conv for this session id - fall through and
                // create one so capture still has a home.
              }
            }
            if (!convGuidForHooks && cfg?.projectGuid) {
              // Terminal `gipity claude` is always origin='local' - marks the
              // conversation as a local-terminal chat so the web CLI renders
              // it read-only. Dispatch convs (created by the relay daemon
              // spawning `gipity claude -p`) use the default 'dispatch'.
              const created = await post<{ data: { conversation_guid: string } }>(
                '/conversations/claude-code',
                { project_guid: cfg.projectGuid, device_guid: device.guid, origin: 'local' },
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

      // Pass through all unknown args to claude (everything after 'claude').
      // Gipity-level flags are stripped: boolean flags dropped outright,
      // value-bearing flags drop the flag and its value (both `--f v` and
      // `--f=v` forms).
      const claudeIdx = process.argv.indexOf('claude');
      const rawClaudeArgs = process.argv.slice(claudeIdx + 1);
      const gipityBooleanFlags = new Set(['--setup-only', '--new-project', '--here', '--quiet']);
      const gipityValueFlags = ['--api-base', '--name', '--project'];
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
        console.log(`  ${muted("Just tell Claude what you'd like to build or do - everything Claude can do,")}`);
        console.log(`  ${muted('plus hosting, databases, and live deploys on Gipity.')}`);
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

      // Resolve full path on Windows so we can avoid shell:true, which
      // passes args through cmd.exe and mangles quotes/special chars.
      const claudeCmd = resolveCommand('claude');
      const childEnv = { ...process.env };
      // Gate hook-based capture: when the daemon is streaming via
      // --output-format stream-json, it owns the capture and any hook
      // post would be a dupe. Leaving GIPITY_CONVERSATION_GUID unset in
      // the child's env trips the hook runner's early-return guard.
      const streamJsonIdx = allArgs.indexOf('--output-format');
      const daemonCapturing = streamJsonIdx !== -1 && allArgs[streamJsonIdx + 1] === 'stream-json';
      if (daemonCapturing) {
        delete childEnv.GIPITY_CONVERSATION_GUID;
      } else if (convGuidForHooks) {
        childEnv.GIPITY_CONVERSATION_GUID = convGuidForHooks;
      }
      // A Gipity project directory is trusted by construction - the user
      // created or explicitly chose it. Pre-accept Claude's per-directory
      // trust dialog so an interactive launch doesn't stop to ask. Headless
      // `-p` runs skip the dialog already, so this is only needed interactively.
      if (!nonInteractive) markFolderTrusted(process.cwd());

      const child = spawn(claudeCmd, allArgs, {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: childEnv,
      });
      child.on('exit', (code) => {
        const doneLine = `Done (${formatElapsed(Date.now() - runStart)})`;
        if (nonInteractive) process.stderr.write(`\n${doneLine}\n\n`);
        else console.log(`\n  ${doneLine}`);
        process.exit(code ?? 0);
      });

    } catch (err: any) {
      console.error(`\n  ${clrError(`Error: ${err.message}`)}`);
      process.exit(1);
    }
  });

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
  // Pickable single-keypress range is 1-9; leave one slot for "Show all"
  // when there are more projects than fit.
  const maxRecent = 9 - reserved - 1; // worst case: keep slot 9 free for "show all"
  const recent = filtered.slice(0, maxRecent);
  const hasMore = filtered.length > recent.length;

  // Loop so that a refused/declined adopt-cwd re-shows the picker rather
  // than dropping the user into a shell.
  while (true) {
    const newProjectLabel = formatNewProjectLabel(existingSlugs);
    console.log(`  ${bold('Choose project to open:')}\n`);
    console.log(`    ${bold('1.')} Create new project          ${muted(`(${newProjectLabel})`)}`);
    if (showAdopt) {
      console.log(`    ${bold('2.')} Use this directory          ${muted(`(${formatCwdLabel(cwd)})`)}`);
    }
    recent.forEach((p, i) =>
      console.log(`    ${bold(`${i + reserved + 1}.`)} ${p.name} ${muted(`(${p.slug})`)}`),
    );
    if (hasMore) {
      console.log(`    ${bold(`${recent.length + reserved + 1}.`)} Show all projects`);
    }
    console.log('');

    const maxOption = recent.length + reserved + (hasMore ? 1 : 0);
    const idx = await pickOne('Choose', maxOption, 1);

    // Recent project (slots reserved+1 .. recent.length+reserved).
    if (idx > reserved && idx <= recent.length + reserved) {
      return { kind: 'pick', project: recent[idx - reserved - 1] };
    }

    // Show all projects (one past the last recent slot).
    if (hasMore && idx === recent.length + reserved + 1) {
      const picked = await pickFromAll(filtered);
      if (picked) return { kind: 'pick', project: picked };
      continue; // user bailed; re-show top picker
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

/** Render "Show all projects" with numbered list; returns the picked
 *  project or null if the user picked "create new" (slot 1) or invalid. */
async function pickFromAll(filtered: ProjectData[]): Promise<ProjectData | null> {
  console.log('');
  console.log(`  ${bold('All projects:')}\n`);
  console.log(`    ${bold('1.')} Create new project`);
  filtered.forEach((p, i) => console.log(`    ${bold(`${i + 2}.`)} ${p.name} ${muted(`(${p.slug})`)}`));
  console.log('');
  const allChoice = await prompt(`  Choose (1-${filtered.length + 1}): `);
  const allIdx = parseInt(allChoice, 10);
  if (allIdx >= 2 && allIdx <= filtered.length + 1) return filtered[allIdx - 2];
  return null;
}

/** Show "(~/GipityProjects/project-NNN)" - the exact dir option 1 will
 *  create, so the user can see where their new project will land. */
function formatNewProjectLabel(existingSlugs: string[]): string {
  const slug = suggestProjectName(existingSlugs);
  const root = getProjectsRoot();
  const home = homedir();
  const display = root.startsWith(home + '/') || root === home
    ? '~' + root.slice(home.length)
    : root;
  return `${display}/${slug}`;
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
      const device = relayState.getDevice();
      const body: { name: string; slug: string; autoChat?: 'claude_code'; deviceGuid?: string } = { name: projectName, slug: projectSlug };
      if (device) { body.autoChat = 'claude_code'; body.deviceGuid = device.guid; }
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


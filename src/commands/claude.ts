import { Command } from 'commander';
import { join, dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
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
import { getAuth, saveAuth, clearAuth } from '../auth.js';
import { get, post, publicPost, ApiError, getAccountSlug } from '../api.js';
import { getConfig, saveConfig, clearConfigCache, getApiBaseOverride } from '../config.js';
import { syncDown, syncUp } from '../sync.js';
import { slugify, setupClaudeHooks, setupClaudeMd, setupGitignore, DEFAULT_SYNC_IGNORE, isSyncIgnored } from '../setup.js';
import {
  buildProjectContextBlock as buildProjectContextBlockText,
  buildExistingProjectPrompt as buildExistingProjectPromptText,
  buildNewProjectPrompt,
  buildResumeWrap,
  buildFreshWrap,
} from '../prompts.js';
import * as relayState from '../relay/state.js';
import { maybeOfferRelayOn, ensureDaemonRunning } from '../relay/onboarding.js';
import { prompt, promptBoxed, pickOne, decodeJwtExp, confirm } from '../utils.js';
import { brand, bold, faint, info, success, error as clrError, muted } from '../colors.js';
import { printBanner } from '../banner.js';

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
 *  local filesystem — which only sees depth 1 without recursion and led
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
 *  assembly to `prompts.ts`. All wording lives in that module — keep it
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

async function buildExistingProjectPrompt(opts: LocalCtxOpts): Promise<string> {
  const stats = await fetchProjectStats(opts.projectGuid, opts.cwd);
  return buildExistingProjectPromptText({ ...opts, ...stats });
}

// First-run relay onboarding now lives in `relay/onboarding.ts`
// (`maybeOfferRelayOn`). `gipity claude` invokes it after project
// selection, and also calls `ensureDaemonRunning` unconditionally before
// launching Claude Code so a paired user doesn't have to think about it.

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
  .description('Log in, pair this machine, set up a project, and launch Claude Code (pass -p "msg" / --resume <id> for non-interactive use)')
  .option('--no-claude', 'Set up project but skip launching Claude Code')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (opts) => {
    try {
      // Non-interactive passthrough: `gipity claude -p "msg"` (and --print)
      // route directly to `claude -p` after the normal setup (auth, hooks,
      // sync). Used by the upcoming `gipity relay` daemon to dispatch
      // messages from the web CLI into a local Claude Code session without
      // a human at the terminal. Requires an existing .gipity.json — we
      // can't interactively pick or create a project in this mode.
      const rawArgs = process.argv.slice(process.argv.indexOf('claude') + 1);
      const nonInteractive = rawArgs.some(a => a === '-p' || a === '--print' || a.startsWith('--print=') || a.startsWith('-p='));

      // In non-interactive mode, route all banner/progress output to stderr
      // so the child's stream-json on stdout stays clean.
      if (nonInteractive) {
        const origLog = console.log;
        console.log = (...args: unknown[]) => { void origLog; console.error(...args); };
      }

      // ── Step 1: Auth ──────────────────────────────────────────────────
      let auth = getAuth();

      if (nonInteractive && !auth) {
        console.error(`  ${clrError('Not logged in. Run: gipity login')}`);
        process.exit(1);
      }
      if (nonInteractive && !getConfig()) {
        console.error(`  ${clrError('No Gipity project in cwd. Run `gipity claude` (interactive) first to set one up.')}`);
        process.exit(1);
      }

      if (!nonInteractive) {
        printBanner({ version: __clPkg.version, email: auth?.email, cwd: process.cwd() });
      }

      if (auth) {
        console.log(`  Logged in as ${auth.email}`);
      } else {
        console.log('  Let\'s get you logged in.\n');

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
        auth = getAuth();
        console.log(`  ${success(`Logged in as ${email}`)}`);
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

      // If cwd already has .gipity.json, use it (user ran from inside a project)
      const existing = getConfig();
      if (existing) {
        console.log(`  Project: ${brand(existing.projectSlug)} ${muted(`(${existing.projectGuid})`)}`);
        console.log(`  ${success('Already set up.')}\n`);
        setupClaudeHooks();
        setupClaudeMd();
        setupGitignore();

        try {
          const upResult = await syncUp();
          if (upResult.pushed > 0) {
            console.log(`  Pushed ${upResult.pushed} file${upResult.pushed > 1 ? 's' : ''} to Gipity.`);
          }
          const downResult = await syncDown({ confirmDeletions: !nonInteractive });
          if (downResult.pulled > 0) {
            console.log(`  Pulled ${downResult.pulled} file${downResult.pulled > 1 ? 's' : ''} from Gipity.`);
          }
        } catch {
          console.log('  Could not sync files (will retry on next prompt).');
        }

        initialPrompt = await buildExistingProjectPrompt({
          projectName: existing.projectSlug,
          projectSlug: existing.projectSlug,
          projectGuid: existing.projectGuid,
          accountSlug: existing.accountSlug,
          cwd: process.cwd(),
        });
      } else {
        // Fetch user's projects
        let projects: ProjectData[] = [];
        try {
          const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
          projects = res.data;
        } catch (err: any) {
          const isConnectionError = err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' ||
            err?.code === 'ETIMEDOUT' || err?.cause?.code === 'ECONNREFUSED' ||
            err?.cause?.code === 'ENOTFOUND' || err?.cause?.code === 'ETIMEDOUT';
          if (isConnectionError) {
            const apiBase = getApiBaseOverride() || 'https://a.gipity.ai';
            console.error(`  ${clrError(`Could not connect to ${apiBase}`)}`);
            console.error(`  ${muted('Check your connection and try again.')}`);
            process.exit(1);
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

        const existingSlugs = projects.map(p => p.slug);
        let project: ProjectData;
        let isNewProject = false;

        if (projects.length > 0) {
          const result = await pickOrCreateProject(projects, existingSlugs);
          project = result.project;
          isNewProject = result.isNew;
        } else {
          project = await createNewProject(existingSlugs);
          isNewProject = true;
        }

        // Resolve project directory under ~/GipityProjects/{slug}
        const projectDir = join(getProjectsRoot(), project.slug);

        mkdirSync(projectDir, { recursive: true });
        process.chdir(projectDir);
        clearConfigCache();

        // Fetch agents
        let agentGuid = '';
        try {
          const agents = await get<{ data: AgentData[] }>(`/projects/${project.short_guid}/agents`);
          if (agents.data.length > 0) agentGuid = agents.data[0].short_guid;
        } catch {
          // No agents
        }

        const accountSlug = await getAccountSlug();

        // Always write config (refresh stale GUIDs from a previous setup)
        saveConfig({
          projectGuid: project.short_guid,
          projectSlug: project.slug,
          accountSlug,
          agentGuid,
          conversationGuid: null,
          apiBase: getApiBaseOverride() || 'https://a.gipity.ai',
          ignore: DEFAULT_SYNC_IGNORE,
        });

        console.log(`\n  Using ${projectDir}`);

        // Sync: push local files up first, then pull any remote-only files down (non-fatal)
        try {
          const upResult = await syncUp();
          if (upResult.pushed > 0) {
            console.log(`  Pushed ${upResult.pushed} file${upResult.pushed > 1 ? 's' : ''} to Gipity.`);
          }
          const downResult = await syncDown({ confirmDeletions: !nonInteractive });
          if (downResult.pulled > 0) {
            console.log(`  Pulled ${downResult.pulled} file${downResult.pulled > 1 ? 's' : ''} from Gipity.`);
          }
        } catch {
          console.log('  Could not sync files (will retry on next prompt).');
        }

        // ── Step 2b: What do you want to build? (new projects only) ────
        if (isNewProject) {
          console.log('');
          console.log(`  ${bold('Claude Code enabled with Gipity!')}`);
          console.log('');
          console.log(`  ${bold("What's next? What would you like to build?")}`);
          console.log(`  ${muted('Examples: a landing page, a Pac-Man game, a full web app,')}`);
          console.log(`  ${muted('an API that returns random facts, an image, just answer questions?')}`);
          console.log('');
          console.log(`  ${muted('Claude Code with Gipity can do everything your old Claude Code could do but so much more now!')}`);
          console.log('');

          const buildIdea = (await promptBoxed()).trim();

          const stats = await fetchProjectStats(project.short_guid, process.cwd());
          initialPrompt = buildNewProjectPrompt({
            projectName: project.name,
            projectSlug: project.slug,
            projectGuid: project.short_guid,
            accountSlug,
            cwd: process.cwd(),
            ...stats,
            buildIdea,
          });
        } else {
          initialPrompt = await buildExistingProjectPrompt({
            projectName: project.name,
            projectSlug: project.slug,
            projectGuid: project.short_guid,
            accountSlug,
            cwd: process.cwd(),
          });
        }

        setupClaudeHooks();
        setupClaudeMd();
        setupGitignore();

        console.log(`  ${success(`Project "${project.name}" ready.`)}\n`);
      }

      // ── Step 3: Launch Claude Code ────────────────────────────────────
      if (opts.claude === false) {
        console.log(`  Done. cd ${process.cwd()} && claude`);
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

      // Resolve (or create) the backing Gipity conversation for this
      // Claude Code run. The conv_guid is handed to the child (and thus
      // every capture hook spawned by Claude Code) via env var so every
      // capture event is explicitly tagged to the right conversation.
      //
      // Three paths:
      //   1. Inherited GIPITY_CONVERSATION_GUID — the relay daemon already
      //      created the conv and spawned us with it set. Just pass it
      //      through. Creating another would orphan the dispatch's conv.
      //   2. `--resume <sid>` — look up the existing conv by Claude Code
      //      session_id.
      //   3. Otherwise — create a fresh claude_code conv tied to this
      //      paired device.
      //
      // Skipped silently if this machine isn't paired — without a device
      // we can't satisfy the claude_code ownership rule, so hooks stay
      // offline for this run.
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
                // No existing conv for this session id — fall through and
                // create one so capture still has a home.
              }
            }
            if (!convGuidForHooks && cfg?.projectGuid) {
              const created = await post<{ data: { conversation_guid: string } }>(
                '/conversations/claude-code',
                { project_guid: cfg.projectGuid, device_guid: device.guid },
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

      // Pass through all unknown args to claude (everything after 'claude')
      const claudeIdx = process.argv.indexOf('claude');
      const knownFlags = ['--no-claude', '--api-base'];
      const claudeArgs = process.argv.slice(claudeIdx + 1).filter(arg => {
        for (const flag of knownFlags) {
          if (arg === flag) return false;
          if (arg.startsWith('--api-base=')) return false;
        }
        return true;
      });
      // Filter out the value after --api-base if space-separated and after claude
      const apiBaseIdx = process.argv.indexOf('--api-base', claudeIdx);
      if (apiBaseIdx !== -1) {
        const valueIdx = claudeArgs.indexOf(process.argv[apiBaseIdx + 1]);
        if (valueIdx !== -1) claudeArgs.splice(valueIdx, 1);
      }

      if (!nonInteractive) {
        console.log(`  ${info('Launching Claude Code...')}\n`);
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
          if (hasResume) {
            // Resume wrap only needs project identity (no file stats), so
            // skip the stats API call on every resumed message.
            wrapped = buildResumeWrap(ctxOpts, userMsg);
          } else {
            wrapped = buildFreshWrap(await buildProjectContextBlock(ctxOpts), userMsg);
          }
          allArgs = [...claudeArgs];
          allArgs[pIdx + 1] = wrapped;
          process.stderr.write(
            `\n── full prompt → claude (${wrapped.length} chars) ──\n` +
            wrapped +
            `\n── end prompt ──\n\n`
          );
        } else {
          allArgs = claudeArgs;
        }
      } else {
        allArgs = initialPrompt ? [initialPrompt, ...claudeArgs] : claudeArgs;
      }
      // Resolve full path on Windows so we can avoid shell:true, which
      // passes args through cmd.exe and mangles quotes/special chars.
      const claudeCmd = resolveCommand('claude');
      const childEnv = { ...process.env };
      if (convGuidForHooks) childEnv.GIPITY_CONVERSATION_GUID = convGuidForHooks;
      const child = spawn(claudeCmd, allArgs, {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: childEnv,
      });
      child.on('exit', (code) => process.exit(code ?? 0));

    } catch (err: any) {
      console.error(`\n  ${clrError(`Error: ${err.message}`)}`);
      process.exit(1);
    }
  });

async function pickOrCreateProject(
  projects: ProjectData[],
  existingSlugs: string[],
): Promise<{ project: ProjectData; isNew: boolean }> {
  const filtered = projects.filter(p => !p.is_default);
  const recent = filtered.slice(0, 7);
  const hasMore = filtered.length > 7;

  console.log(`  ${bold('Choose project to open:')}\n`);
  console.log(`    ${bold('1.')} Create new project`);
  recent.forEach((p, i) => console.log(`    ${bold(`${i + 2}.`)} ${p.name} ${muted(`(${p.slug})`)}`));
  if (hasMore) console.log(`    ${bold(`${recent.length + 2}.`)} Show all projects`);
  console.log('');

  const maxOption = hasMore ? recent.length + 2 : recent.length + 1;
  const idx = await pickOne('Choose', maxOption, 1);

  // Selected a recent project
  if (idx >= 2 && idx <= recent.length + 1) return { project: recent[idx - 2], isNew: false };

  // Show all projects
  if (hasMore && idx === recent.length + 2) {
    console.log('');
    console.log(`  ${bold('All projects:')}\n`);
    console.log(`    ${bold('1.')} Create new project`);
    filtered.forEach((p, i) => console.log(`    ${bold(`${i + 2}.`)} ${p.name} ${muted(`(${p.slug})`)}`));
    console.log('');
    const allChoice = await prompt(`  Choose (1-${filtered.length + 1}): `);
    const allIdx = parseInt(allChoice, 10);
    if (allIdx >= 2 && allIdx <= filtered.length + 1) return { project: filtered[allIdx - 2], isNew: false };
  }

  // Default (Enter) or 1 = create new project
  return { project: await createNewProject(existingSlugs), isNew: true };
}

async function createNewProject(existingSlugs: string[]): Promise<ProjectData> {
  const taken = new Set(existingSlugs);
  let suggested = suggestProjectName(existingSlugs);
  console.log('');

  // Loop until the user picks a free, well-formed name. Bad input or duplicate
  // slugs re-prompt instead of crashing — duplicates can still slip through
  // after the initial projects-list fetch (race with another session), so the
  // server-side 409 also routes back here.
  while (true) {
    const name = await prompt(`  ${bold('Project name')} [${bold(suggested)}]: `);
    const projectName = name || suggested;
    const projectSlug = slugify(projectName);

    if (!projectSlug) {
      console.error(`  ${clrError('Invalid project name. Use letters, numbers, and hyphens.')}`);
      continue;
    }
    if (taken.has(projectSlug)) {
      console.error(`  ${clrError(`"${projectSlug}" already exists. Pick a different name.`)}`);
      suggested = suggestProjectName([...taken]);
      continue;
    }

    process.stdout.write(`  ${info(`Creating "${projectName}"...`)}`);
    try {
      const device = relayState.getDevice();
      const body: { name: string; slug: string; autoChat?: 'claude_code'; deviceGuid?: string } = { name: projectName, slug: projectSlug };
      if (device) { body.autoChat = 'claude_code'; body.deviceGuid = device.guid; }
      const res = await post<{ data: ProjectData }>('/projects', body);
      console.log(` ${success('Created.')}`);
      return res.data;
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        console.log('');
        console.error(`  ${clrError(`"${projectSlug}" was just taken. Pick a different name.`)}`);
        taken.add(projectSlug);
        suggested = suggestProjectName([...taken]);
        continue;
      }
      throw err;
    }
  }
}


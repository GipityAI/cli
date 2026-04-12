import { Command } from 'commander';
import { join, dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
import { getAuth, saveAuth } from '../auth.js';
import { get, post, publicPost } from '../api.js';
import { getConfig, saveConfig, clearConfigCache, getApiBaseOverride } from '../config.js';
import { syncDown, syncUp } from '../sync.js';
import { slugify, setupClaudeHooks, setupClaudeMd, setupGitignore } from '../setup.js';
import { prompt, pickOne, decodeJwtExp } from '../utils.js';
import { brand, bold, faint, info, success, error as clrError, muted } from '../colors.js';
import { printBanner } from '../banner.js';

const __clDir = dirname(fileURLToPath(import.meta.url));
const __clPkg = JSON.parse(readFileSync(resolve(__clDir, '../../package.json'), 'utf-8'));

function getProjectsRoot(): string {
  const settingsPath = join(homedir(), '.gipity', 'settings.json');
  const defaultDir = join(homedir(), 'GipityProjects');
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.projectsDir) return resolve(settings.projectsDir);
    } else {
      mkdirSync(join(homedir(), '.gipity'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ projectsDir: defaultDir }, null, 2) + '\n');
    }
  } catch { /* fall through */ }
  return defaultDir;
}

interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
  is_default?: number;
  user?: { account_slug: string };
}

interface AgentData {
  short_guid: string;
  name: string;
}

function suggestProjectName(existingSlugs: string[]): string {
  const slugSet = new Set(existingSlugs);
  for (let i = 1; i <= 99; i++) {
    const candidate = `project${String(i).padStart(2, '0')}`;
    if (!slugSet.has(candidate)) return candidate;
  }
  return `project-${Date.now().toString(36).slice(-6)}`;
}

export const claudeCommand = new Command('claude')
  .description('Log in, set up a project, and launch Claude Code')
  .option('--no-claude', 'Set up project but skip launching Claude Code')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (opts) => {
    try {
      // ── Step 1: Auth ──────────────────────────────────────────────────
      let auth = getAuth();

      printBanner({ version: __clPkg.version, email: auth?.email, cwd: process.cwd() });

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
      } else {
        // Fetch user's projects
        let projects: ProjectData[] = [];
        let fetchFailed = false;
        try {
          const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
          projects = res.data;
        } catch (err: any) {
          fetchFailed = true;
          const isConnectionError = err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' ||
            err?.code === 'ETIMEDOUT' || err?.cause?.code === 'ECONNREFUSED' ||
            err?.cause?.code === 'ENOTFOUND' || err?.cause?.code === 'ETIMEDOUT';
          if (isConnectionError) {
            const apiBase = getApiBaseOverride() || 'https://a.gipity.ai';
            console.error(`  ${clrError(`Could not connect to ${apiBase}`)}`);
            console.error(`  ${muted('Check your connection and try again.')}`);
            process.exit(1);
          }
          // Non-connection error (e.g. 401) — fall through to create
        }

        const existingSlugs = projects.map(p => p.slug);
        let project: ProjectData;
        let isNewProject = false;

        if (projects.length > 0) {
          const result = await pickOrCreateProject(projects, existingSlugs);
          project = result.project;
          isNewProject = result.isNew;
        } else if (!fetchFailed) {
          project = await createNewProject(existingSlugs);
          isNewProject = true;
        } else {
          console.error(`  ${clrError('Could not load projects. Please try again.')}`);
          process.exit(1);
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

        const accountSlug = project.user?.account_slug || '';

        // Always write config (refresh stale GUIDs from a previous setup)
        saveConfig({
          projectGuid: project.short_guid,
          projectSlug: project.slug,
          accountSlug,
          agentGuid,
          conversationGuid: null,
          apiBase: getApiBaseOverride() || 'https://a.gipity.ai',
          ignore: ['node_modules', '.git', '.gipity.json', '.gipity/', '.claude/', '.gitignore', 'CLAUDE.md', '*.log'],
        });

        console.log(`\n  Using ${projectDir}`);

        // Sync: push local files up first, then pull any remote-only files down (non-fatal)
        try {
          const upResult = await syncUp();
          if (upResult.pushed > 0) {
            console.log(`  Pushed ${upResult.pushed} file${upResult.pushed > 1 ? 's' : ''} to Gipity.`);
          }
          const downResult = await syncDown({ confirmDeletions: true });
          if (downResult.pulled > 0) {
            console.log(`  Pulled ${downResult.pulled} file${downResult.pulled > 1 ? 's' : ''} from Gipity.`);
          }
        } catch {
          console.log('  Could not sync files (will retry on next prompt).');
        }

        // ── Step 2b: What do you want to build? (new projects only) ────
        if (isNewProject) {
          console.log('');
          console.log(`  ${bold('What would you like to build?')}\n`);
          console.log(`  ${muted('Examples: a landing page, a Pac-Man game, a helpdesk app,')}`);
          console.log(`  ${muted('an API that returns random facts, or anything you can describe.')}`);
          console.log(`  ${muted('Press Enter for a blank project.')}\n`);

          const buildIdea = (await prompt('  → ')).trim();

          const projectContext = [
            `You are starting a new project called "${project.name}" on Gipity — an AI agent platform with cloud hosting, databases, serverless functions, sandboxed code execution, image generation, TTS, and web search.`,
            ``,
            `Project directory: ${process.cwd()}`,
            `Deploy URL: https://dev.gipity.ai/${accountSlug}/${project.slug}/`,
            ``,
            `Read CLAUDE.md for full platform docs, CLI commands, and scaffold types.`,
            `Key commands: gipity scaffold --type <web|2d-game|3d-world|app-itsm|api>, gipity deploy dev, gipity test, gipity fn call <name> [body].`,
            `Files auto-sync to the cloud on every save. Deploy gives a live URL instantly.`,
          ].join('\n');

          if (buildIdea) {
            initialPrompt = `${projectContext}\n\nThe user's first message: "${buildIdea}"\n\nGet started on their request. Scaffold if appropriate, or build from scratch — use your judgment. Deploy to dev when you have something working.`;
          } else {
            initialPrompt = `${projectContext}\n\nThe user started a blank project with no specific request. Briefly introduce yourself, highlight a few key capabilities, and ask what they want to build.`;
          }
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

      console.log(`  ${info('Launching Claude Code...')}\n`);
      const allArgs = initialPrompt
        ? [initialPrompt, ...claudeArgs]
        : claudeArgs;
      // Resolve full path on Windows so we can avoid shell:true, which
      // passes args through cmd.exe and mangles quotes/special chars.
      const claudeCmd = resolveCommand('claude');
      const child = spawn(claudeCmd, allArgs, {
        stdio: 'inherit',
        cwd: process.cwd(),
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
  const suggested = suggestProjectName(existingSlugs);
  console.log('');
  const name = await prompt(`  ${bold('Project name')} [${bold(suggested)}]: `);
  const projectName = name || suggested;
  const projectSlug = slugify(projectName);

  if (!projectSlug) {
    console.error(`  ${clrError('Invalid project name.')}`);
    process.exit(1);
  }

  console.log(`  ${info(`Creating "${projectName}"...`)}`);
  const res = await post<{ data: ProjectData }>('/projects', { name: projectName, slug: projectSlug });
  console.log(`  ${success('Created.')}`);
  return res.data;
}


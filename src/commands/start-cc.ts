import { Command } from 'commander';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';

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
import { getConfig, saveConfig, clearConfigCache } from '../config.js';
import { syncDown, syncUp } from '../sync.js';
import { slugify, setupClaudeHooks, setupClaudeMd, setupGitignore } from '../setup.js';
import { prompt, decodeJwtExp } from '../utils.js';

const PROJECTS_ROOT = join(homedir(), 'GipityProjects');

interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
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

export const startCcCommand = new Command('start-cc')
  .description('Log in, set up a project, and launch Claude Code')
  .option('--no-claude', 'Set up project but skip launching Claude Code')
  .option('--api-base <url>', 'API base URL', 'https://a.gipity.ai')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (opts) => {
    try {
      console.log('');
      console.log('  Welcome to Gipity');
      console.log('  ─────────────────');
      console.log('');

      // ── Step 1: Auth ──────────────────────────────────────────────────
      let auth = getAuth();

      if (auth) {
        console.log(`  Logged in as ${auth.email}`);
      } else {
        console.log('  Let\'s get you logged in.\n');

        const email = await prompt('  Email: ');
        if (!email) { console.error('\n  Email required.'); process.exit(1); }

        await publicPost('/auth/login', { email });
        console.log('  Check your email for a 6-digit code.\n');

        const code = await prompt('  Code: ');
        if (!code) { console.error('\n  Code required.'); process.exit(1); }

        const res = await publicPost<{
          accessToken: string;
          refreshToken: string;
          isNewUser: boolean;
        }>('/auth/verify', { email, code });

        const exp = decodeJwtExp(res.accessToken);
        if (!exp) { console.error('\n  Invalid token received.'); process.exit(1); }
        const expiresAt = new Date(exp * 1000).toISOString();

        saveAuth({ accessToken: res.accessToken, refreshToken: res.refreshToken, email, expiresAt });
        auth = getAuth();
        console.log(`\n  Authenticated as ${email}`);
      }

      console.log('');

      // ── Step 2: Project ───────────────────────────────────────────────
      let initialPrompt = '';

      // If cwd already has .gipity.json, use it (user ran from inside a project)
      const existing = getConfig();
      if (existing) {
        console.log(`  Project: ${existing.projectSlug} (${existing.projectGuid})`);
        console.log('  Already set up.\n');
        setupClaudeHooks();
        setupClaudeMd();
        setupGitignore();
      } else {
        // Fetch user's projects
        let projects: ProjectData[] = [];
        try {
          const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
          projects = res.data;
        } catch {
          // Can't list — we'll create fresh
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
        const projectDir = join(PROJECTS_ROOT, project.slug);

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
          apiBase: opts.apiBase,
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

        // ── Step 2b: Project type (new projects only) ───────────────────
        if (isNewProject) {
          const projectType = await pickProjectType();
          initialPrompt = projectType.initialPrompt;

          if (projectType.scaffoldType) {
            console.log(`  Scaffolding ${projectType.label}...`);
            try {
              await post(`/projects/${project.short_guid}/scaffold`, {
                title: project.name,
                type: projectType.scaffoldType,
              });
              const scaffoldSync = await syncDown();
              if (scaffoldSync.pulled > 0) {
                console.log(`  Created ${scaffoldSync.pulled} starter file${scaffoldSync.pulled > 1 ? 's' : ''}.`);
              }
            } catch {
              console.log('  Scaffolding failed — starting with empty project.');
            }
          }
        }

        setupClaudeHooks();
        setupClaudeMd();
        setupGitignore();

        console.log(`  Project "${project.name}" ready.\n`);
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

      // Pass through all unknown args to claude
      const knownFlags = ['--no-claude', '--api-base'];
      const claudeArgs = process.argv.slice(3).filter(arg => {
        for (const flag of knownFlags) {
          if (arg === flag) return false;
          if (arg.startsWith('--api-base=')) return false;
        }
        return true;
      });
      // Filter out the value after --api-base if space-separated
      const apiBaseIdx = process.argv.indexOf('--api-base');
      if (apiBaseIdx !== -1) {
        const valueIdx = claudeArgs.indexOf(process.argv[apiBaseIdx + 1]);
        if (valueIdx !== -1) claudeArgs.splice(valueIdx, 1);
      }

      console.log('  Launching Claude Code...\n');
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
      console.error(`\n  Error: ${err.message}`);
      process.exit(1);
    }
  });

async function pickOrCreateProject(
  projects: ProjectData[],
  existingSlugs: string[],
): Promise<{ project: ProjectData; isNew: boolean }> {
  console.log('  Your projects:');
  projects.forEach((p, i) => console.log(`    ${i + 1}. ${p.name} (${p.slug})`));
  console.log(`    ${projects.length + 1}. Create new project`);
  console.log('');

  const choice = await prompt(`  Choose (1-${projects.length + 1}): `);
  const idx = parseInt(choice, 10);

  if (idx >= 1 && idx <= projects.length) return { project: projects[idx - 1], isNew: false };
  return { project: await createNewProject(existingSlugs), isNew: true };
}

async function createNewProject(existingSlugs: string[]): Promise<ProjectData> {
  const suggested = suggestProjectName(existingSlugs);
  const name = await prompt(`  Project name [${suggested}]: `);
  const projectName = name || suggested;
  const projectSlug = slugify(projectName);

  if (!projectSlug) {
    console.error('  Invalid project name.');
    process.exit(1);
  }

  console.log(`  Creating "${projectName}"...`);
  const res = await post<{ data: ProjectData }>('/projects', { name: projectName, slug: projectSlug });
  console.log('  Created.');
  return res.data;
}

interface ProjectTypeChoice {
  label: string;
  scaffoldType?: string;
  initialPrompt: string;
}

const PROJECT_TYPE_OPTIONS: ProjectTypeChoice[] = [
  {
    label: 'Web app',
    scaffoldType: 'web',
    initialPrompt: 'This is a new web app project on Gipity. The project has been scaffolded with starter HTML/CSS/JS. Deploy it to dev so I can see it live. Then briefly introduce yourself, mention that I have access to databases, server-side API endpoints, image generation, web search, and cloud hosting, and ask me what I want to build.',
  },
  {
    label: '3D World game',
    scaffoldType: '3d-world',
    initialPrompt: 'This is a new 3D World game on Gipity. Deploy it to dev so I can play it right away. Then briefly introduce yourself, mention that I can customize the world, objects, physics, game logic, and multiplayer, and ask me what kind of game I want to make.',
  },
  {
    label: 'Start empty',
    initialPrompt: 'This is a new empty project on Gipity. Briefly introduce yourself, mention that I have access to cloud hosting, databases, server-side API endpoints, sandboxed code execution, image generation, speech, and web search, and ask me what I want to build.',
  },
];

async function pickProjectType(): Promise<ProjectTypeChoice> {
  console.log('');
  console.log('  What kind of project?\n');
  console.log('    1. Web app');
  console.log('       Website, dashboard, tool, or browser game — scaffolds HTML/CSS/JS starter files.\n');
  console.log('    2. 3D World game');
  console.log('       3D multiplayer game with Three.js + Rapier physics — scaffolds a playable starter world.\n');
  console.log('    3. Start empty');
  console.log('       No scaffolding. Begin with a blank project and build everything from scratch.\n');

  const choice = await prompt('  Choose (1-3): ');
  const idx = parseInt(choice, 10);

  if (idx >= 1 && idx <= 3) return PROJECT_TYPE_OPTIONS[idx - 1];
  // Default to empty on invalid input
  return PROJECT_TYPE_OPTIONS[2];
}

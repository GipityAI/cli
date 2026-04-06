import { Command } from 'commander';
import { basename } from 'path';
import { get, post } from '../api.js';
import { saveConfig, getConfig } from '../config.js';
import { syncDown } from '../sync.js';
import { getAuth } from '../auth.js';
import { slugify, setupClaudeHooks, setupClaudeMd, setupGitignore } from '../setup.js';

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

export const initCommand = new Command('init')
  .description('Initialize a Gipity project (new or existing)')
  .argument('[name]', 'Project name/slug (defaults to current directory name)')
  .option('--agent <guid>', 'Agent GUID to use')
  .option('--api-base <url>', 'API base URL', 'https://a.gipity.ai')
  .action(async (name: string | undefined, opts) => {
    try {
      // Check auth
      const auth = getAuth();
      if (!auth) {
        console.error('Not logged in. Run: gipity login');
        process.exit(1);
      }

      // Check if already initialized
      const existing = getConfig();
      if (existing) {
        console.log(`Already linked to "${existing.projectSlug}" (${existing.projectGuid})`);
        // Re-run setup in case hooks/skills are missing
        setupClaudeHooks();
        setupClaudeMd();
        setupGitignore();
        console.log('Configuring Claude Code... done.');
        return;
      }

      // Resolve project name
      const projectName = name || basename(process.cwd());
      const projectSlug = slugify(projectName);

      if (!projectSlug) {
        console.error('Could not derive a valid project slug. Provide a name: gipity init my-app');
        process.exit(1);
      }

      // Search for existing project by slug
      let project: ProjectData | null = null;
      let accountSlug = '';

      try {
        const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
        project = res.data.find(p => p.slug === projectSlug) || null;
        if (project) {
          accountSlug = project.user?.account_slug || '';
        }
      } catch {
        // List failed — we'll create a new project
      }

      if (project) {
        console.log(`Found existing project "${project.name}" (${project.slug})`);
      } else {
        // Create new project
        const res = await post<{ data: ProjectData }>('/projects', {
          name: projectName,
          slug: projectSlug,
        });
        project = res.data;
        accountSlug = project.user?.account_slug || '';
        console.log(`Created project "${project.name}" (${project.slug})`);
      }

      // Find agent for the project
      let agentGuid = opts.agent || '';
      if (!agentGuid) {
        try {
          const agents = await get<{ data: AgentData[] }>(`/projects/${project.short_guid}/agents`);
          if (agents.data.length > 0) {
            agentGuid = agents.data[0].short_guid;
          }
        } catch {
          // No agents — that's fine
        }
      }

      // 1. Write .gipity.json
      saveConfig({
        projectGuid: project.short_guid,
        projectSlug: project.slug,
        accountSlug,
        agentGuid,
        conversationGuid: null,
        apiBase: opts.apiBase,
        ignore: ['node_modules', '.git', '.gipity.json', '.gipity/', '.claude/', '.gitignore', 'CLAUDE.md', '*.log'],
      });

      // 2. Pull existing files
      const result = await syncDown();
      if (result.pulled > 0) {
        console.log(`Pulled ${result.pulled} file${result.pulled > 1 ? 's' : ''}.`);
      }

      // 3. Write .claude/settings.json (CC hooks)
      setupClaudeHooks();

      // 4. Write CLAUDE.md (skills)
      setupClaudeMd();

      // 5. Update .gitignore
      setupGitignore();

      console.log('Configuring Claude Code... done.');
      console.log('Ready! Run `claude` to start.');
    } catch (err: any) {
      console.error(`Init failed: ${err.message}`);
      process.exit(1);
    }
  });

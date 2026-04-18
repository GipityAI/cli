import { Command } from 'commander';
import { basename } from 'path';
import { get, post, getAccountSlug } from '../api.js';
import { getConfig } from '../config.js';
import { getAuth } from '../auth.js';
import { slugify, setupClaudeHooks, setupClaudeMd, setupGitignore } from '../setup.js';
import { finalizeLocalProject } from '../project-setup.js';
import { success, error as clrError, info, muted } from '../colors.js';

interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
}

interface AgentData {
  short_guid: string;
  name: string;
}

export const initCommand = new Command('init')
  .description('Initialize a Gipity project (new or existing)')
  .argument('[name]', 'Project name/slug (defaults to current directory name)')
  .option('--agent <guid>', 'Agent GUID to use')
  .action(async (name: string | undefined, opts) => {
    try {
      // Check auth
      const auth = getAuth();
      if (!auth) {
        console.error(clrError('Not logged in. Run: gipity login'));
        process.exit(1);
      }

      // Check if already initialized
      const existing = getConfig();
      if (existing) {
        console.log(`Already linked to ${info(`"${existing.projectSlug}"`)} ${muted(`(${existing.projectGuid})`)}`);
        // Re-run setup in case hooks/skills are missing
        setupClaudeHooks();
        setupClaudeMd();
        setupGitignore();
        console.log(success('Configuring Claude Code... done.'));
        return;
      }

      // Resolve project name
      const projectName = name || basename(process.cwd());
      const projectSlug = slugify(projectName);

      if (!projectSlug) {
        console.error(clrError('Could not derive a valid project slug. Provide a name: gipity init my-app'));
        process.exit(1);
      }

      // Search for existing project by slug
      let project: ProjectData | null = null;

      try {
        const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
        project = res.data.find(p => p.slug === projectSlug) || null;
      } catch {
        // List failed — we'll create a new project
      }

      if (project) {
        console.log(`Found existing project ${info(`"${project.name}"`)} ${muted(`(${project.slug})`)}`);
      } else {
        // Create new project
        const res = await post<{ data: ProjectData }>('/projects', {
          name: projectName,
          slug: projectSlug,
          autoChat: 'claude_code',
        });
        project = res.data;
        console.log(success(`Created project "${project.name}" (${project.slug})`));
      }

      const accountSlug = await getAccountSlug();

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

      const { pushed, pulled } = await finalizeLocalProject({
        dir: process.cwd(),
        projectGuid: project.short_guid,
        projectSlug: project.slug,
        accountSlug,
        agentGuid,
        sync: 'strict',
        confirmDeletions: true,
      });
      if (pushed > 0) console.log(`Pushed ${pushed} file${pushed > 1 ? 's' : ''} to Gipity.`);
      if (pulled > 0) console.log(`Pulled ${pulled} file${pulled > 1 ? 's' : ''}.`);

      console.log(success('Configuring Claude Code... done.'));
      console.log(success('Ready! Run `claude` to start.'));
    } catch (err: any) {
      console.error(clrError(`Init failed: ${err.message}`));
      process.exit(1);
    }
  });

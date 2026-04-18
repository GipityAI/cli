import { Command } from 'commander';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { get, post, put, del, getAccountSlug } from '../api.js';
import { requireConfig, saveConfig } from '../config.js';
import { slugify } from '../setup.js';
import { error as clrError, brand, muted, info, success } from '../colors.js';
import { confirm } from '../utils.js';
import { run, printList } from '../helpers/index.js';
import { getProjectsRoot } from '../relay/paths.js';
import { finalizeLocalProject } from '../project-setup.js';
import * as relayState from '../relay/state.js';

interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: number;
  created_at: string;
}

interface AgentData {
  short_guid: string;
  name: string;
}

export const projectCommand = new Command('project')
  .description('Manage projects')
  .argument('[name]', 'Switch to project by name/slug')
  .option('--json', 'Output as JSON')
  .action((name: string | undefined, opts) => run('Project', async () => {
    const config = requireConfig();

    if (name) {
      // Switch to project
      const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
      const match = res.data.find(p => p.slug === name || p.name === name || p.short_guid === name);
      if (!match) {
        console.error(clrError(`Project "${name}" not found.`));
        process.exit(1);
      }
      saveConfig({ ...config, projectGuid: match.short_guid, projectSlug: match.slug, conversationGuid: null });
      if (opts.json) {
        console.log(JSON.stringify({ switched: match.slug, guid: match.short_guid }));
      } else {
        console.log(`Switched to ${match.name} (${match.slug})`);
      }
      return;
    }

    // List projects
    const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=100');
    printList(res.data, opts, 'No projects.', p => {
      const active = p.short_guid === config.projectGuid ? ` ${brand('*')}` : '';
      const def = p.is_default ? ` ${muted('(default)')}` : '';
      return `${p.slug}${active}${def}`;
    });
  }));

projectCommand
  .command('create <name>')
  .description('Create a new project, materialize it under ~/GipityProjects, and link this machine to it')
  .option('--slug <slug>', 'Project slug')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Create', async () => {
    const slug = opts.slug || slugify(name);

    // Auto-chat so the project surfaces at the top of both picker lists —
    // `projects.dal.ts` orders by most recent conversation activity. Same
    // shape `gipity claude` uses for its picker-created projects.
    const device = relayState.getDevice();
    const body: {
      name: string; slug: string;
      autoChat?: 'claude_code' | 'gip';
      deviceGuid?: string;
    } = { name, slug };
    if (device) {
      body.autoChat = 'claude_code';
      body.deviceGuid = device.guid;
    } else {
      body.autoChat = 'gip';
    }

    const res = await post<{ data: ProjectData }>('/projects', body);
    const project = res.data;

    // Materialize a local dir and link it. We write `.gipity.json` directly
    // inside the new dir (via `saveConfigAt`, used by `finalizeLocalProject`)
    // so running this from inside another project's dir never walks up and
    // rewrites that project's config.
    const dir = join(getProjectsRoot(), project.slug);
    mkdirSync(dir, { recursive: true });

    const accountSlug = await getAccountSlug();

    // Resolve the first assigned agent (if any) — not fatal if missing.
    let agentGuid = '';
    try {
      const agents = await get<{ data: AgentData[] }>(`/projects/${project.short_guid}/agents`);
      if (agents.data.length > 0) agentGuid = agents.data[0].short_guid;
    } catch {
      // offline or no agents — non-fatal
    }

    const { pushed, pulled } = await finalizeLocalProject({
      dir,
      projectGuid: project.short_guid,
      projectSlug: project.slug,
      accountSlug,
      agentGuid,
      sync: 'soft',
      confirmDeletions: false,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        created: project.slug,
        guid: project.short_guid,
        dir,
        pushed,
        pulled,
      }));
      return;
    }

    console.log(success(`Created "${project.name}" (${project.slug})`));
    console.log(`Initialized ${info(dir)}`);
    if (pushed > 0) console.log(`Pushed ${pushed} file${pushed > 1 ? 's' : ''} to Gipity.`);
    if (pulled > 0) console.log(`Pulled ${pulled} file${pulled > 1 ? 's' : ''}.`);
    console.log('');
    if (process.env.GIPITY_NON_INTERACTIVE === '1') {
      console.log(`${muted('Next:')} switch to "${project.name}" in the sidebar.`);
    } else {
      console.log(`${muted('Next:')} exit Claude (Ctrl+D), then run:  ${brand('gipity claude')}`);
      console.log(`${muted('Pick')} "${project.name}" ${muted(`— it'll be at the top of the list.`)}`);
    }
  }));

projectCommand
  .command('delete <name>')
  .description('Delete a project')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Delete', async () => {
    // Resolve name to guid
    const res = await get<{ data: ProjectData[] }>('/projects?limit=100');
    const match = res.data.find(p => p.slug === name || p.name === name || p.short_guid === name);
    if (!match) {
      console.error(`Project "${name}" not found.`);
      process.exit(1);
    }
    if (!await confirm(`Delete project "${match.name}"? This cannot be undone.`)) {
      console.log('Cancelled.');
      return;
    }
    await del(`/projects/${match.short_guid}`);

    if (opts.json) {
      console.log(JSON.stringify({ deleted: match.slug }));
    } else {
      console.log(`Deleted "${match.name}".`);
    }
  }));

projectCommand
  .command('rename <name> <new-name>')
  .description('Rename a project (display name only — slug and URLs are unchanged)')
  .option('--json', 'Output as JSON')
  .action((name: string, newName: string, opts) => run('Rename', async () => {
    const res = await get<{ data: ProjectData[] }>('/projects?limit=100');
    const match = res.data.find(p => p.slug === name || p.name === name || p.short_guid === name);
    if (!match) {
      console.error(clrError(`Project "${name}" not found.`));
      process.exit(1);
    }
    await put(`/projects/${match.short_guid}`, { name: newName });

    if (opts.json) {
      console.log(JSON.stringify({ renamed: match.slug, from: match.name, to: newName }));
    } else {
      console.log(`Renamed "${match.name}" -> "${newName}" (slug ${match.slug} unchanged).`);
    }
  }));

projectCommand
  .command('info')
  .description('Show current project details')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Info', async () => {
    const config = requireConfig();
    const res = await get<{ data: ProjectData }>(`/projects/${config.projectGuid}`);
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      const p = res.data;
      console.log(`Name:    ${p.name}`);
      console.log(`Slug:    ${p.slug}`);
      console.log(`GUID:    ${p.short_guid}`);
      console.log(`Created: ${new Date(p.created_at).toLocaleDateString()}`);
      if (p.description) console.log(`Desc:    ${p.description}`);
    }
  }));

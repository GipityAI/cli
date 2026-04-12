import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { requireConfig, saveConfig } from '../config.js';
import { slugify } from '../setup.js';
import { error as clrError, brand, muted } from '../colors.js';
import { confirm } from '../utils.js';
import { run, printList } from '../helpers/index.js';

interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: number;
  created_at: string;
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
  .description('Create a new project')
  .option('--slug <slug>', 'Project slug')
  .option('--switch', 'Switch to new project after creation')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Create', async () => {
    const slug = opts.slug || slugify(name);
    const res = await post<{ data: ProjectData }>('/projects', { name, slug });

    if (opts.switch) {
      const config = requireConfig();
      saveConfig({ ...config, projectGuid: res.data.short_guid, projectSlug: res.data.slug, conversationGuid: null });
    }

    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(`Created "${res.data.name}" (${res.data.slug})`);
      if (opts.switch) console.log('Switched.');
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
    if (!await confirm(`Delete project "${match.name}"? This cannot be undone. (y/N) `)) {
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

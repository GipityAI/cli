import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { requireConfig, saveConfig } from '../config.js';
import { slugify } from '../setup.js';
import { error as clrError, success, brand, muted } from '../colors.js';

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
  .action(async (name: string | undefined, opts) => {
    try {
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
      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No projects.');
        } else {
          for (const p of res.data) {
            const active = p.short_guid === config.projectGuid ? ` ${brand('*')}` : '';
            const def = p.is_default ? ` ${muted('(default)')}` : '';
            console.log(`${p.slug}${active}${def}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`Failed: ${err.message}`));
      process.exit(1);
    }
  });

projectCommand
  .command('create <name>')
  .description('Create a new project')
  .option('--slug <slug>', 'Project slug')
  .option('--switch', 'Switch to new project after creation')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
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
    } catch (err: any) {
      console.error(clrError(`Create failed: ${err.message}`));
      process.exit(1);
    }
  });

projectCommand
  .command('delete <name>')
  .description('Delete a project')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      // Resolve name to guid
      const res = await get<{ data: ProjectData[] }>('/projects?limit=100');
      const match = res.data.find(p => p.slug === name || p.name === name || p.short_guid === name);
      if (!match) {
        console.error(`Project "${name}" not found.`);
        process.exit(1);
      }
      await del(`/projects/${match.short_guid}`);

      if (opts.json) {
        console.log(JSON.stringify({ deleted: match.slug }));
      } else {
        console.log(`Deleted "${match.name}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Delete failed: ${err.message}`));
      process.exit(1);
    }
  });

projectCommand
  .command('info')
  .description('Show current project details')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
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
    } catch (err: any) {
      console.error(clrError(`Info failed: ${err.message}`));
      process.exit(1);
    }
  });

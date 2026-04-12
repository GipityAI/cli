import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { syncDown } from '../sync.js';
import { success } from '../colors.js';
import { run } from '../helpers/index.js';

export const scaffoldCommand = new Command('scaffold')
  .description('Create app structure (src/ with HTML, CSS, JS, favicons)')
  .argument('[title]', 'App title (defaults to project name)')
  .requiredOption('--type <type>', 'Project type: web-simple, web-fullstack, 2d-game, 3d-world, app-itsm, or api')
  .option('--description <desc>', 'App description for meta tags')
  .option('--json', 'Output as JSON')
  .action((title: string | undefined, opts) => run('Scaffold', async () => {
    const config = requireConfig();
    const appTitle = title || config.projectSlug;

    const res = await post<{
      data: { files: string[]; title: string; type: string };
    }>(`/projects/${config.projectGuid}/scaffold`, {
      title: appTitle,
      description: opts.description,
      type: opts.type,
    });

    // Sync down the created files
    const syncResult = await syncDown();

    if (opts.json) {
      console.log(JSON.stringify({ ...res.data, synced: syncResult.pulled }));
    } else {
      console.log(success(`Scaffolded "${res.data.title}" with ${res.data.files.length} files:`));
      for (const f of res.data.files) {
        console.log(`  ${f}`);
      }
      if (syncResult.pulled > 0) {
        console.log(`\nPulled ${syncResult.pulled} files to local.`);
      }
    }
  }));

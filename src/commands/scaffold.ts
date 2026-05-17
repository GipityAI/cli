import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { sync } from '../sync.js';
import { success } from '../colors.js';
import { run } from '../helpers/index.js';

// Scaffold types grouped by kind. Mirrors SCAFFOLD_TEMPLATES in
// platform/packages/shared - kept inline here because the CLI is published
// as a standalone npm package and can't depend on the private shared
// workspace. When adding/removing/promoting an entry, update both lists.
//
// Templates are minimal wiring (start fresh). Starter apps are working demos.
// Hidden entries are accepted by the server but not suggested by default -
// they're shown to the agent in a "do-not-suggest-unsolicited" line so the
// LLM can still pick one when the user asks for that domain by name.
const VISIBLE_TEMPLATES = ['web-simple', '3d-engine'] as const;
const VISIBLE_STARTERS = ['web-fullstack', '2d-game', '3d-world', 'api'] as const;
const HIDDEN_STARTERS: Array<{ key: string; hint: string }> = [
  { key: 'app-itsm', hint: 'IT service management / helpdesk / ticketing / incident management' },
];
const visibleTypeList = [
  `templates: ${VISIBLE_TEMPLATES.join(', ')}`,
  `starters: ${VISIBLE_STARTERS.join(', ')}`,
].join(' | ');
const hiddenTypeList = HIDDEN_STARTERS.length
  ? ' | hidden (do NOT suggest unsolicited; use only when the user explicitly asks for that domain): ' +
    HIDDEN_STARTERS.map(h => `${h.key} (${h.hint})`).join(', ')
  : '';

export const scaffoldCommand = new Command('scaffold')
  .description('Create an app from a template')
  .argument('[title]', 'App title (defaults to project name)')
  .requiredOption('--type <type>', `Project type: ${visibleTypeList}${hiddenTypeList}`)
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
    const syncResult = await sync({ interactive: false });

    if (opts.json) {
      console.log(JSON.stringify({ ...res.data, synced: syncResult.applied }));
    } else {
      console.log(success(`Scaffolded "${res.data.title}" with ${res.data.files.length} files:`));
      for (const f of res.data.files) {
        console.log(`  ${f}`);
      }
      if (syncResult.applied > 0) {
        console.log(`\nPulled ${syncResult.applied} files to local.`);
      }
    }
  }));

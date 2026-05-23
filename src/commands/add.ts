import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { sync } from '../sync.js';
import { success, muted, bold } from '../colors.js';
import { run } from '../helpers/index.js';

// Catalog mirrored from platform/packages/shared (SCAFFOLD_TEMPLATES + KITS) -
// the CLI ships as a standalone npm package and can't depend on the private
// shared workspace. Keep these lists in sync when catalog entries change.
//
// Templates scaffold a whole app (blank wiring or a working starter demo).
// Kits are reusable building blocks added into an existing app's src/packages/.
const TEMPLATES = ['web-simple', '3d-engine'];
const STARTERS = ['web-fullstack', 'web-vision-cam', '2d-game', '3d-world', 'api'];
const HIDDEN = [{ key: 'app-itsm', hint: 'IT service management / helpdesk / ticketing' }];
const KITS = [
  { key: 'realtime', hint: 'multiplayer / presence / shared state' },
  { key: 'web-vision-mediapipe', hint: 'browser camera vision - gesture, pose, object detection' },
];

function printCatalog(): void {
  console.log('');
  console.log(`${bold('Templates')}  ${muted('- scaffold a whole app into an empty project')}`);
  console.log(`  ${TEMPLATES.join(', ')}  ${muted('(blank wiring)')}`);
  console.log(`  ${STARTERS.join(', ')}  ${muted('(working demos)')}`);
  console.log('');
  console.log(`${bold('Kits')}  ${muted('- add a reusable building block into an existing app')}`);
  for (const k of KITS) console.log(`  ${k.key}  ${muted('- ' + k.hint)}`);
  console.log('');
  console.log(muted('Usage: gipity add <name> [--title <t>] [--description <d>] [--force]'));
  console.log('');
}

interface AddResponse {
  kind: 'template' | 'kit';
  files: string[];
  title?: string;
  type?: string;
  kit?: string;
  notes?: string[];
}

export const addCommand = new Command('add')
  .description('Add a template (scaffold an app) or a kit (reusable building block) to the project')
  .argument('[name]', 'Template or kit key - omit to list the catalog')
  .option('--title <title>', 'App title - templates only (defaults to project name)')
  .option('--description <desc>', 'App description for meta tags - templates only')
  .option('--force', 'Templates only: overwrite any colliding files')
  .option('--json', 'Output as JSON')
  .action((name: string | undefined, opts) => run('Add', async () => {
    if (!name) {
      printCatalog();
      return;
    }
    const config = requireConfig();

    const res = await post<{ data: AddResponse }>(`/projects/${config.projectGuid}/add`, {
      name,
      title: opts.title,
      description: opts.description,
      force: opts.force,
    });

    // Pull the created/installed files down to local.
    const syncResult = await sync({ interactive: false });
    const data = res.data;

    if (opts.json) {
      console.log(JSON.stringify({ ...data, synced: syncResult.applied }));
      return;
    }

    if (data.kind === 'kit') {
      console.log(success(`Added the "${data.kit}" kit - ${data.files.length} file(s):`));
    } else {
      console.log(success(`Scaffolded "${data.title}" (${data.type}) - ${data.files.length} files:`));
    }
    for (const f of data.files) console.log(`  ${f}`);
    if (data.notes?.length) {
      console.log('');
      for (const n of data.notes) console.log(n);
    }
    // After scaffolding an app, point at kits as the next step - they add
    // features (multiplayer, etc.) into the app you just created.
    if (data.kind !== 'kit' && KITS.length > 0) {
      console.log('');
      console.log(muted('Add features with kits (gipity add <kit>):'));
      for (const k of KITS) console.log(muted(`  ${k.key}  - ${k.hint}`));
    }
    if (syncResult.applied > 0) {
      console.log(`\nPulled ${syncResult.applied} files to local.`);
    }
  }));

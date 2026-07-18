import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { sync } from '../sync.js';
import { success, muted } from '../colors.js';
import { run } from '../helpers/index.js';
import { confirm } from '../utils.js';
import { createProgressReporter, withSpinner } from '../progress.js';

interface RemoveResponse {
  kind: 'kit';
  kit: string;
  removed: string[];
  notes: string[];
}

export const removeCommand = new Command('remove')
  .description('Remove a kit')
  .argument('<kit>', 'Kit key/directory under src/packages/ to remove')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('--json', 'Output as JSON')
  .action((kit: string, opts) => run('Remove', async () => {
    const config = requireConfig();

    if (!opts.yes && !opts.json) {
      if (!await confirm(`Remove the "${kit}" kit (its files, import-map entries, and gipity.yaml wiring)?`)) {
        console.log('Cancelled.');
        return;
      }
    }

    const doRemove = () => post<{ data: RemoveResponse }>(`/projects/${config.projectGuid}/remove`, { name: kit });
    const res = opts.json
      ? await doRemove()
      : await withSpinner('Removing...', doRemove, { done: null });
    const data = res.data;
    // Pull the kit's deletions locally. Whitelist ONLY the kit's own removed files
    // so they bypass the bulk-delete guard (the removal is explicit), while any
    // unrelated mass deletion pending on either side is still guarded - a blanket
    // `force` here would let that ride in silently.
    const syncResult = await sync({
      interactive: false,
      deleteWhitelist: data.removed ?? [],
      progress: opts.json ? undefined : createProgressReporter(),
    });

    if (opts.json) {
      console.log(JSON.stringify({ ...data, synced: syncResult.applied }));
      return;
    }

    console.log(success(`Removed the "${data.kit}" kit.`));
    for (const r of data.removed) console.log(muted(`  - ${r}`));
    if (data.notes?.length) {
      console.log('');
      for (const n of data.notes) console.log(n);
    }
    if (syncResult.applied > 0) {
      console.log(`\nPulled ${syncResult.applied} change(s) to local.`);
    }
  }));

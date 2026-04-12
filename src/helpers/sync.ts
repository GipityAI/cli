/**
 * sync.ts — Shared sync-before-action helper.
 */

import { syncUp } from '../sync.js';
import { muted } from '../colors.js';

/**
 * Sync local files to server before an action (deploy, test, scaffold).
 * Respects --no-sync and --json flags.
 */
export async function syncBeforeAction(opts: { sync?: boolean; json?: boolean }): Promise<void> {
  if (opts.sync === false) return;
  const result = await syncUp();
  if (result.pushed > 0 && !opts.json) {
    console.log(muted(`Synced ${result.pushed} file${result.pushed > 1 ? 's' : ''}`));
  }
}

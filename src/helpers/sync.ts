/**
 * sync.ts - Shared sync-before-action helper.
 */

import { sync } from '../sync.js';
import { muted, error as clrError } from '../colors.js';

/**
 * Sync local files with the server before an action (deploy, test, scaffold).
 * Respects --no-sync and --json flags. Non-interactive: bulk-deletion guard
 * blocks accidental wipes from hooks; user must run `gipity sync` manually
 * (or pass --force) to unblock. `--force` on the action (e.g. `deploy --force`)
 * forwards to the sync so it bypasses the guard too - one flag, forceful across
 * the board, matching `gipity sync --force`.
 */
export async function syncBeforeAction(opts: { sync?: boolean; json?: boolean; force?: boolean }): Promise<void> {
  if (opts.sync === false) return;
  const result = await sync({ interactive: false, force: opts.force });
  if (result.applied > 0 && !opts.json) {
    console.log(muted(`Synced ${result.applied} change${result.applied > 1 ? 's' : ''}`));
  }
  if (result.errors.length > 0 && !opts.json) {
    for (const e of result.errors) console.error(clrError(`[sync] ${e}`));
  }
}

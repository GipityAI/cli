/**
 * sync.ts - Shared sync-before-action helper.
 */

import { sync, isLocalTreeClean } from '../sync.js';
import { muted, error as clrError } from '../colors.js';
import { createProgressReporter } from '../progress.js';

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
  // Nothing changed locally since the last sync → nothing to push, and the
  // action (deploy etc.) reads server-side state anyway. Skip the whole sync
  // round trip. The probe is local-only stat checks and conservative: any
  // doubt (size/mtime moved, never synced, no baseline) falls through to a
  // real sync. `--force` always takes the full path.
  if (!opts.force && isLocalTreeClean()) return;
  // Pass a progress reporter so a large pre-action upload shows the transfer
  // bar instead of a silent pause (the reporter is a no-op on non-TTY / when
  // piped, so JSON and headless output stay clean).
  const result = await sync({
    interactive: false,
    force: opts.force,
    progress: opts.json ? undefined : createProgressReporter(),
  });
  if (result.applied > 0 && !opts.json) {
    console.log(muted(`Synced ${result.applied} change${result.applied > 1 ? 's' : ''}`));
  }
  if (result.errors.length > 0 && !opts.json) {
    for (const e of result.errors) console.error(clrError(`[sync] ${e}`));
  }
}

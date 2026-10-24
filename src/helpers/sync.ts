/**
 * sync.ts - Shared sync-before-action helper.
 */

import { sync, isLocalTreeClean, appUploadNote, heldLargeNote } from '../sync.js';
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
  const note = appUploadNote(result.appUploadsLeftLocal);
  if (note && !opts.json) console.log(muted(note));
  const held = heldLargeNote(result.heldLarge);
  if (held && !opts.json) console.log(muted(held));
  if (result.errors.length > 0 && !opts.json) {
    for (const e of result.errors) console.error(clrError(`[sync] ${e}`));
  }
  // A conflict means the server copy won the real path and the local edit was
  // moved aside. Carrying on would run the action on code the caller never
  // wrote (a GipRunner build deployed every function public this way), so stop.
  const conflicts = result.plan.actions.filter(a => a.kind === 'conflict');
  if (conflicts.length > 0) {
    const lines = conflicts.map(a => `  ${a.path}: the server copy changed too; your local edit was saved as "${a.renamedLocalTo ?? '(conflict copy)'}"`);
    throw new Error(
      `Stopped before running: local edits conflicted with newer server copies.\n${lines.join('\n')}\n`
      + 'Nothing was run against the server. Put the version you want at the real path (often: re-apply your edit on top of the server copy), delete the conflict copy, then run the command again.',
    );
  }
}

/**
 * Pull down files the action itself wrote on the server. A deploy can rewrite
 * source (auto-declared functions in gipity.yaml, a share card re-synced to the
 * page title); the editor hooks only pull before the next user turn, so an agent
 * editing right after the deploy would read the stale local copy.
 */
export async function syncAfterAction(opts: { sync?: boolean; json?: boolean }): Promise<void> {
  if (opts.sync === false) return;
  const result = await sync({ interactive: false });
  if (result.applied > 0 && !opts.json) {
    console.log(muted(`Pulled ${result.applied} file${result.applied > 1 ? 's' : ''} the deploy updated`));
  }
  if (result.errors.length > 0 && !opts.json) {
    for (const e of result.errors) console.error(clrError(`[sync] ${e}`));
  }
}

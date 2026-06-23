/**
 * command.ts - Shared command execution helpers.
 * Eliminates duplicated try/catch + clrError + process.exit pattern.
 */

import { error as clrError } from '../colors.js';

/**
 * Wrap an async command action with standardized error handling.
 * Catches errors, prints a formatted message, and exits with code 1.
 *
 * Usage:
 *   .action((name, opts) => run('Create', async () => { ... }))
 */
/**
 * Print a command error. Out-of-credits is a recoverable, user-actionable
 * state, so flag it plainly (and keep the server's message, which carries the
 * buy link) - that way an agent reading this output, e.g. Claude Code, can tell
 * the user they're out of Gipity credits and where to top up rather than
 * treating it as a hard failure. Does not exit; the caller decides.
 */
export function printCommandError(label: string, err: any): void {
  if (err?.code === 'INSUFFICIENT_CREDITS') {
    console.error(clrError(`${label} failed - out of Gipity credits.`));
    console.error(err.message);
    return;
  }
  console.error(clrError(`${label} failed: ${err.message}`));
}

export function run(label: string, action: () => Promise<void>): void {
  action().catch((err: any) => {
    printCommandError(label, err);
    process.exit(1);
  });
}

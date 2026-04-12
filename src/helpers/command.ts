/**
 * command.ts — Shared command execution helpers.
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
export function run(label: string, action: () => Promise<void>): void {
  action().catch((err: any) => {
    console.error(clrError(`${label} failed: ${err.message}`));
    process.exit(1);
  });
}

/**
 * output.ts - Shared output formatting helpers.
 * Eliminates duplicated JSON/list/empty-state patterns.
 */
import type { Command } from 'commander';

/** Whether the in-flight command opened a non-JSON output frame (leading blank
 *  printed, trailing blank still owed). Module-level so the process-exit handler
 *  can close a frame even when a command ends via process.exit() and so skips
 *  the postAction hook. */
let frameOpen = false;

/**
 * Bracket every human (non-JSON) command's stdout with exactly one leading and
 * one trailing blank line, so output is visually separated from the shell
 * prompt and consistent across commands. JSON output is left untouched so it
 * stays pipe/parse-clean.
 *
 * Centralizing the frame here is what lets individual commands stop printing
 * their own leading/trailing blank lines (and stops them doubling up at the
 * boundaries). Call once on the root program; Commander runs these lifecycle
 * hooks for the actual subcommand action too.
 */
export function installOutputFrame(program: Command): void {
  // Only decorate a real terminal. When stdout is piped or redirected (a relay
  // capturing stream-json, `| less`, tests), leave it byte-clean - same policy
  // colors.ts uses for ANSI. This keeps headless `claude -p` stdout empty.
  if (!process.stdout.isTTY) return;
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals
      ? actionCommand.optsWithGlobals()
      : actionCommand.opts();
    if (opts.json) return; // never decorate machine output
    process.stdout.write('\n');
    frameOpen = true;
  });
  program.hook('postAction', () => {
    if (frameOpen) { process.stdout.write('\n'); frameOpen = false; }
  });
  // Commands that finish via process.exit() never reach postAction; close the
  // frame from the exit handler instead (sync write, fires on every exit path).
  process.on('exit', () => {
    if (frameOpen) process.stdout.write('\n');
  });
}

/**
 * Print data as JSON or formatted text.
 * Handles the ubiquitous `if (opts.json) { ... } else { ... }` pattern.
 */
export function printOutput(data: unknown, opts: { json?: boolean }, formatter: (d: any) => string): void {
  if (opts.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(formatter(data));
  }
}

/** Print a one-line result message (text mode only). The surrounding blank
 *  lines come from the central output frame, not from here. */
export function printResult(text: string, opts: { json?: boolean }, jsonData?: unknown): void {
  if (opts.json) {
    console.log(JSON.stringify(jsonData ?? { success: true }));
    return;
  }
  console.log(text);
}

/**
 * Pluck a nested value out of a result by dot-path. Numeric segments index into
 * arrays, so `items.0.short_guid` reaches the first item's guid. Returns
 * `undefined` if any segment along the way is missing. This is what lets
 * `--field` replace the `... | node -e "JSON.parse(...)"` extraction dance.
 */
export function pluckField(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]),
    data,
  );
}

/**
 * Emit a single plucked field for `--field`. Scalars print raw (no quotes) so
 * the output drops straight into `$(...)` / pipes; objects/arrays print as
 * compact JSON. A missing path is an error (exit 1) so scripts fail loudly
 * instead of silently consuming an empty string.
 */
export function emitField(data: unknown, path: string): void {
  const value = pluckField(data, path);
  if (value === undefined) {
    console.error(`Field not found: ${path}`);
    process.exit(1);
  }
  console.log(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
}

/**
 * Print a list with JSON mode, empty state, and per-item formatting.
 * Replaces the most common output pattern across all commands.
 */
export function printList<T>(
  data: T[],
  opts: { json?: boolean },
  emptyMsg: string,
  formatter: (item: T) => string,
  header?: string,
): void {
  if (opts.json) {
    console.log(JSON.stringify(data));
    return;
  }
  // Surrounding blank lines come from the central output frame.
  if (data.length === 0) {
    console.log(emptyMsg);
  } else {
    // A `header` is a one-line lead-in (e.g. "Read one with `gipity skill
    // read <name>`:") that tells the reader what the listed names are for.
    if (header) {
      console.log(header);
      console.log('');
    }
    for (const item of data) {
      console.log(formatter(item));
    }
  }
}

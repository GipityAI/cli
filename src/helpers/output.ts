/**
 * output.ts — Shared output formatting helpers.
 * Eliminates duplicated JSON/list/empty-state patterns.
 */

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

/**
 * Print a list with JSON mode, empty state, and per-item formatting.
 * Replaces the most common output pattern across all commands.
 */
export function printList<T>(
  data: T[],
  opts: { json?: boolean },
  emptyMsg: string,
  formatter: (item: T) => string,
): void {
  if (opts.json) {
    console.log(JSON.stringify(data));
  } else if (data.length === 0) {
    console.log(emptyMsg);
  } else {
    for (const item of data) {
      console.log(formatter(item));
    }
  }
}

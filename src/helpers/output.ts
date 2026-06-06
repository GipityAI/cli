/**
 * output.ts - Shared output formatting helpers.
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

/** Print a one-line success message wrapped in blank lines (text mode only). */
export function printResult(text: string, opts: { json?: boolean }, jsonData?: unknown): void {
  if (opts.json) {
    console.log(JSON.stringify(jsonData ?? { success: true }));
    return;
  }
  console.log('');
  console.log(text);
  console.log('');
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
  console.log('');
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
  console.log('');
}

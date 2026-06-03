/**
 * command.ts - Shared command execution helpers.
 * Eliminates duplicated try/catch + clrError + process.exit pattern.
 */

import { error as clrError } from '../colors.js';
import { ApiError } from '../api.js';

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

// A page command runs on a pooled headless-browser worker, so a timeout has two
// very different causes that the bare server message ('[Browser command timed
// out]') can't tell apart: the worker never handed back a session (infra) vs.
// the worker ran but the page was slow to load/settle. An agent that can't tell
// wastes turns re-probing the same dead capability.
const isTimeout = (e: ApiError): boolean =>
  e.statusCode === 504 || /timed out|timeout/i.test(e.message) || /TIMEOUT/i.test(e.code);

// Slow-page timeouts already name an actionable cause (raise --wait, use
// --wait-for, lighten the page), so leave their message untouched.
const isSlowPage = (e: ApiError): boolean =>
  /navigat|selector|wait[- ]?for|eval|did not (finish|settle|load)/i.test(`${e.code} ${e.message}`);

/** Rewrite an ambiguous browser timeout into worker-outage guidance + the curl
 *  fallback; pass every other error (incl. slow-page timeouts) through. */
function classifyBrowserError(err: unknown, url: string): unknown {
  if (!(err instanceof ApiError) || !isTimeout(err) || isSlowPage(err)) return err;
  return new ApiError(
    err.statusCode,
    err.code,
    'browser worker did not respond — usually a transient infra issue, not your page. ' +
      'Retrying page commands is unlikely to help until the worker recovers. Verify the deploy directly:\n' +
      `  curl -s -o /dev/null -w "%{http_code}\\n" ${url}\n` +
      `then re-check per asset. (worker: ${err.message})`,
  );
}

/**
 * `run` for page/browser subcommands: enriches the ambiguous '[Browser command
 * timed out]' so the agent can tell a worker outage from a slow page.
 *
 * Usage:
 *   .action((url, opts) => runBrowser('Page inspect', url, async () => { ... }))
 */
export function runBrowser(label: string, url: string, action: () => Promise<void>): void {
  run(label, async () => {
    try {
      await action();
    } catch (err) {
      throw classifyBrowserError(err, url);
    }
  });
}

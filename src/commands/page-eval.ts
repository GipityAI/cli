import { Command } from 'commander';
import { post } from '../api.js';
import { brand, bold, muted } from '../colors.js';
import { run } from '../helpers/index.js';

interface EvalResult {
  url: string;
  result: string;
  truncated: boolean;
}

// The long-tail escape hatch alongside `page inspect`'s fixed bundle: when the
// curated metrics don't cover what you need (computed styles, element rects,
// visibility, z-index stacks), eval an expression in page context and get the
// serialized result back. Runs in the same browser sandbox as inspect.
export const pageEvalCommand = new Command('eval')
  .description('Evaluate a JS expression in a real browser on a page (DOM, computed styles, element rects)')
  .argument('<url>', 'URL to load')
  .argument('<expr>', 'JavaScript expression to evaluate in page context (result is JSON-serialized)')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before evaluating (lets late async work settle)', '500')
  .option('--json', 'Output as JSON')
  .action((url: string, expr: string, opts) => run('Page eval', async () => {
    const parsedWait = parseInt(opts.wait, 10);
    const waitMs = Number.isFinite(parsedWait) && parsedWait >= 0 ? parsedWait : 500;

    const res = await post<{ data: EvalResult }>('/tools/browser/eval', { url, expr, waitMs });
    const d = res.data;

    if (opts.json) {
      console.log(JSON.stringify(d));
      return;
    }

    console.log(`\n${brand('Eval')} ${bold(d.url || url)}`);
    console.log(`  ${muted('Expression:')} ${expr}`);
    console.log(`\n${d.result || muted('(empty result)')}`);
    if (d.truncated) console.log(muted('\n(result truncated to fit context - narrow the expression for the full value)'));
    console.log('');
  }));

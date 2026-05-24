import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { get } from '../api.js';
import { brand, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

const PRICING_URL = 'https://prompt.gipity.ai/pricing';

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' :
    'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Spawn failed (no xdg-open on minimal Linux, etc.) - caller prints the URL.
  }
}

interface BalanceData {
  available: number;
  bySource: { subscription: number; purchase: number; bonus: number };
  balances: Array<{ source: string; creditsRemaining: number; expiresAt: string }>;
}

interface UsageEntry {
  operation: string;
  creditsDeducted: number;
  costUsd: number;
  modelId: string | null;
  createdAt: string;
}

export const creditsCommand = new Command('credits')
  .description('View credits')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Credits', async () => {
    const res = await get<{ data: BalanceData }>('/credits/balance');
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(`Credits: ${brand(res.data.available.toLocaleString())}`);
      if (res.data.balances.length > 0) {
        for (const b of res.data.balances) {
          const exp = new Date(b.expiresAt).toLocaleDateString();
          console.log(`  ${b.source}: ${b.creditsRemaining.toLocaleString()}  ${muted(`expires ${exp}`)}`);
        }
      }
    }
  }));

creditsCommand
  .command('buy')
  .description('Open the credits purchase page in your browser')
  .action(() => run('Buy credits', async () => {
    console.log(`Opening ${brand(PRICING_URL)} in your browser...`);
    openInBrowser(PRICING_URL);
    console.log(muted("If your browser didn't open automatically, copy the URL above."));
  }));

creditsCommand
  .command('usage')
  .description('Show recent usage')
  .option('--limit <n>', 'Number of entries', '20')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Usage', async () => {
    const limit = parseInt(opts.limit, 10) || 20;
    const res = await get<{ data: UsageEntry[] }>(`/credits/usage?limit=${limit}`);

    printList(res.data, opts, 'No usage history.', u => {
      const date = new Date(u.createdAt).toLocaleString();
      const model = u.modelId ? `  [${u.modelId}]` : '';
      return `${u.operation}  -${u.creditsDeducted}${model}  ${date}`;
    });
  }));

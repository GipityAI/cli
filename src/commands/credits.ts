import { Command } from 'commander';
import { get } from '../api.js';
import { brand, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

interface BalanceData {
  totalCredits: number;
  balances: Array<{ source: string; credits: number; expiresAt: string }>;
}

interface UsageEntry {
  operation: string;
  creditsDeducted: number;
  costUsd: number;
  modelId: string | null;
  createdAt: string;
}

export const creditsCommand = new Command('credits')
  .description('View credits and usage')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Credits', async () => {
    const res = await get<{ data: BalanceData }>('/credits/balance');
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(`Credits: ${brand(res.data.totalCredits.toLocaleString())}`);
      if (res.data.balances.length > 0) {
        for (const b of res.data.balances) {
          const exp = new Date(b.expiresAt).toLocaleDateString();
          console.log(`  ${b.source}: ${b.credits.toLocaleString()}  ${muted(`expires ${exp}`)}`);
        }
      }
    }
  }));

creditsCommand
  .command('usage')
  .description('Show recent credit usage')
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

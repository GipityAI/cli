import { Command } from 'commander';
import { get } from '../api.js';
import { error as clrError, brand, muted } from '../colors.js';

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
  .action(async (opts) => {
    try {
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
    } catch (err: any) {
      console.error(clrError(`Failed: ${err.message}`));
      process.exit(1);
    }
  });

creditsCommand
  .command('usage')
  .description('Show recent credit usage')
  .option('--limit <n>', 'Number of entries', '20')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const limit = parseInt(opts.limit, 10) || 20;
      const res = await get<{ data: UsageEntry[] }>(`/credits/usage?limit=${limit}`);
      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No usage history.');
        } else {
          for (const u of res.data) {
            const date = new Date(u.createdAt).toLocaleString();
            const model = u.modelId ? `  [${u.modelId}]` : '';
            console.log(`${u.operation}  -${u.creditsDeducted}${model}  ${date}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`Usage failed: ${err.message}`));
      process.exit(1);
    }
  });

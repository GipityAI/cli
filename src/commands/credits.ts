import { Command } from 'commander';
import { spawnCommand } from '../platform.js';
import { get } from '../api.js';
import { brand, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

const PRICING_URL = 'https://prompt.gipity.ai/pricing';

function openInBrowser(url: string): void {
  // Windows `start` is a cmd.exe builtin, not an executable - spawn can't
  // launch it directly, so go through `cmd /c start`. The empty "" is the
  // window-title arg; without it a quoted URL would be swallowed as the title.
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] as const :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const :
    ['xdg-open', [url]] as const;
  try {
    const child = spawnCommand(cmd, args, { stdio: 'ignore', detached: true });
    // A missing/non-executable launcher (ENOENT, or EACCES on WSL/minimal Linux
    // where xdg-open isn't runnable) is reported ASYNCHRONOUSLY via an 'error'
    // event - not a throw - so the try/catch alone can't stop it. With no
    // listener Node escalates it to an unhandled 'error' and crashes the whole
    // process. Swallow it; the caller already printed the URL as the fallback.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Synchronous spawn failure - caller prints the URL.
  }
}

interface BalanceData {
  available: number;
  bySource: { subscription: number; purchase: number; bonus: number };
  balances: Array<{ source: string; creditsRemaining: number; expiresAt: string }>;
}

interface SubscriptionData {
  tier: string;
  status: string;
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
    if (opts.json) {
      const res = await get<{ data: BalanceData }>('/credits/balance');
      console.log(JSON.stringify(res.data));
      return;
    }
    const [balRes, subRes] = await Promise.all([
      get<{ data: BalanceData }>('/credits/balance'),
      get<{ data: SubscriptionData }>('/credits/subscription'),
    ]);
    const sub = subRes.data;
    const tierLabel = sub.tier === 'pro' ? 'Gipity Pro' : 'Free';
    console.log(`Plan: ${brand(tierLabel)} ${muted(`(${sub.status})`)}`);
    console.log(`Credits: ${brand(balRes.data.available.toLocaleString())}`);
    if (balRes.data.balances.length > 0) {
      for (const b of balRes.data.balances) {
        const exp = new Date(b.expiresAt).toLocaleDateString();
        console.log(`${b.source}: ${b.creditsRemaining.toLocaleString()}  ${muted(`expires ${exp}`)}`);
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
  // optsWithGlobals(): the parent `credits` command also declares --json, which
  // commander binds to the parent - so read merged opts to see the flag here.
  .action((_opts, cmd: Command) => run('Usage', async () => {
    const opts = cmd.optsWithGlobals();
    const limit = parseInt(opts.limit, 10) || 20;
    const res = await get<{ data: UsageEntry[] }>(`/credits/usage?limit=${limit}`);

    printList(res.data, opts, 'No usage history.', u => {
      const date = new Date(u.createdAt).toLocaleString();
      const model = u.modelId ? `  [${u.modelId}]` : '';
      return `${u.operation}  -${u.creditsDeducted}${model}  ${date}`;
    });
  }));

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { get } from '../api.js';
import { brand, muted, success, error as clrError } from '../colors.js';
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
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Spawn failed (no xdg-open on minimal Linux, etc.) - caller prints the URL.
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

interface BillingStatus {
  mode: string;
  secretKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  webhookPath: string;
  packsConfigured: boolean;
  packsError: string | null;
  testPackConfigured: boolean;
  packs: Array<{ name: string; priceId: string; amountUsd: number; credits: number; hidden: boolean }>;
  subscriptionPlans: Array<{ tier: string; name: string; priceIdConfigured: boolean }>;
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
  .command('status')
  .description('Show billing/Stripe configuration health (admin only)')
  .option('--json', 'Output as JSON')
  // optsWithGlobals(): the parent `credits` command also declares --json, which
  // commander binds to the parent - so read merged opts to see the flag here.
  .action((_opts, cmd: Command) => run('Billing status', async () => {
    const opts = cmd.optsWithGlobals();
    const res = await get<{ data: BillingStatus }>('/admin/billing-status');
    const s = res.data;
    if (opts.json) {
      console.log(JSON.stringify(s));
      return;
    }
    const mark = (ok: boolean) => (ok ? success('✓') : clrError('✗'));
    console.log(`Stripe mode:     ${brand(s.mode)}`);
    console.log(`Secret key:      ${mark(s.secretKeyConfigured)}`);
    console.log(`Webhook secret:  ${mark(s.webhookSecretConfigured)}  ${muted(`endpoint ${s.webhookPath}`)}`);
    console.log(`Credit packs:    ${mark(s.packsConfigured)}${s.packsError ? `  ${clrError(s.packsError)}` : ''}`);
    for (const p of s.packs) {
      console.log(`  ${p.name}  ${muted(p.priceId)}${p.hidden ? muted(' [hidden]') : ''}`);
    }
    console.log(`Test pack ($1):  ${mark(s.testPackConfigured)}  ${muted('set STRIPE_PACK_TEST_PRICE_ID to enable a cheap purchase smoke test')}`);
    console.log('Subscription plans:');
    for (const pl of s.subscriptionPlans) {
      console.log(`  ${pl.name} (${pl.tier})  ${mark(pl.priceIdConfigured)}`);
    }
  }));

creditsCommand
  .command('usage')
  .description('Show recent usage')
  .option('--limit <n>', 'Number of entries', '20')
  .option('--json', 'Output as JSON')
  // optsWithGlobals(): parent `credits` also declares --json (see status above).
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

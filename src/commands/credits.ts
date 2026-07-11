import { Command } from 'commander';
import { spawnCommand } from '../platform.js';
import { get, post, ApiError } from '../api.js';
import { brand, dim, bold, muted, success } from '../colors.js';
import type { RetentionData } from './storage.js';
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

// ---- Plan limits formatting (folded in from the old `plan` command) ----
// Every key the plan definition enforces is rendered, so `credits` /
// `credits list` are a full-transparency view of what your plan actually caps.
const LIMIT_LABELS: Record<string, string> = {
  maxProjects: 'Projects',
  maxDatabases: 'Databases',
  storageQuotaBytes: 'Storage',
  maxWorkflows: 'Workflows',
  minCronIntervalHours: 'Cron frequency',
  maxConcurrentChats: 'Concurrent chats',
  deployRatePerMinute: 'Deploys/min',
  testFileConcurrency: 'Parallel tests',
};

// Nested serviceLimits (media generation entitlements). Convention:
// -1 = unlimited, 0 = Pro-only (blocked on free), N = N free uses/month.
const SERVICE_LABELS: Record<string, string> = {
  video: 'Video generation',
  music: 'Music generation',
  image: 'Image generation',
  audio: 'Speech & sound FX',
};

function formatLimit(key: string, value: unknown): string {
  if (typeof value !== 'number') return String(value);
  if (key === 'storageQuotaBytes') {
    const gb = value / (1024 ** 3);
    return `${gb.toFixed(gb >= 1 ? 1 : 2)} GB`;
  }
  if (key === 'minCronIntervalHours') {
    return value === 0 ? 'no minimum' : `${value}h minimum`;
  }
  return value.toLocaleString();
}

function formatServiceLimit(value: unknown): string {
  if (value === -1) return 'unlimited';
  if (value === 0) return 'Pro only';
  if (typeof value === 'number') return `${value.toLocaleString()}/mo free`;
  return String(value);
}

function renderLimits(limits: Record<string, unknown>, indent = ''): void {
  for (const key of Object.keys(LIMIT_LABELS)) {
    const value = limits[key];
    if (value !== undefined) {
      console.log(`${indent}${LIMIT_LABELS[key].padEnd(18)} ${formatLimit(key, value)}`);
    }
  }
  const services = limits.serviceLimits;
  if (services && typeof services === 'object') {
    console.log(`${indent}Media generation`);
    for (const key of Object.keys(SERVICE_LABELS)) {
      const value = (services as Record<string, unknown>)[key];
      if (value !== undefined) {
        console.log(`${indent}  ${SERVICE_LABELS[key].padEnd(16)} ${formatServiceLimit(value)}`);
      }
    }
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

interface LimitsResponse {
  tier: string;
  planAppliedAt: string | null;
  limits: Record<string, unknown>;
}

interface PlanRow {
  shortGuid: string;
  tier: string;
  displayName: string;
  monthlyPriceUsd: number;
  monthlyCredits: number;
  creditExpiryDays: number;
  stripePriceId: string | null;
  limits: Record<string, unknown>;
}

interface ProductEntry {
  priceId: string;
  type: 'subscription' | 'one_time';
  name: string;
  amountUsd: number;
  credits: number;
  available: boolean;
}

interface CheckoutData {
  checkoutUrl: string;
  sessionId: string;
  creditsRequested: number;
  amountUsd: number;
}

interface UsageEntry {
  operation: string;
  creditsDeducted: number;
  costUsd: number;
  modelId: string | null;
  createdAt: string;
}

// `credits` is the single account/billing hub: tier, live balance, the full set
// of plan limits, and an upgrade nudge. `plan` aliases to it (so old muscle
// memory resolves to one implementation); compare plans with `plan list`.
export const creditsCommand = new Command('credits')
  .alias('plan')
  .description('Show your plan, credit balance, and limits')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Credits', async () => {
    // Version retention rides alongside the Storage limit; a failure fetching it
    // must not sink the whole view, so degrade to null and omit the line.
    const fetchRetention = () =>
      get<{ data: RetentionData }>('/users/me/retention').then(r => r.data).catch(() => null);
    if (opts.json) {
      const [balRes, limitsRes, subRes, retention] = await Promise.all([
        get<{ data: BalanceData }>('/credits/balance'),
        get<{ data: LimitsResponse }>('/users/me/limits'),
        get<{ data: SubscriptionData }>('/credits/subscription'),
        fetchRetention(),
      ]);
      console.log(JSON.stringify({ subscription: subRes.data, balance: balRes.data, limits: limitsRes.data, retention }));
      return;
    }
    const [balRes, subRes, limitsRes, retention] = await Promise.all([
      get<{ data: BalanceData }>('/credits/balance'),
      get<{ data: SubscriptionData }>('/credits/subscription'),
      get<{ data: LimitsResponse }>('/users/me/limits'),
      fetchRetention(),
    ]);
    const sub = subRes.data;
    const tierLabel = sub.tier === 'pro' ? 'Gipity Pro' : 'Free';
    console.log(`Plan: ${brand(tierLabel)} ${muted(`(${sub.status})`)}`);
    console.log(`Credits: ${brand(balRes.data.available.toLocaleString())}`);
    if (balRes.data.balances.length > 0) {
      for (const b of balRes.data.balances) {
        const exp = new Date(b.expiresAt).toLocaleDateString();
        console.log(`  ${b.source}: ${b.creditsRemaining.toLocaleString()}  ${muted(`expires ${exp}`)}`);
      }
    }
    console.log('\nLimits:');
    renderLimits(limitsRes.data.limits, '  ');
    if (retention) {
      console.log(`  ${'Version retention'.padEnd(18)} ${retention.days} days / ${retention.count} copies`);
    }
    console.log('');
    if (sub.tier !== 'pro') {
      console.log(dim('Upgrade to Gipity Pro for higher limits and 20,000 credits/mo — run `gipity credits buy`.'));
    } else {
      console.log(dim('Need more credits? Run `gipity credits list` to see credit packs, then `gipity credits buy <pack>`.'));
      console.log(dim('Manage or cancel your subscription with `gipity credits manage`.'));
    }
  }));

// `credits list` compares every plan (with full limits) and the available
// credit packs — the "what can I upgrade to" view.
creditsCommand
  .command('list')
  .description('Compare all plans and credit packs')
  .option('--json', 'Output as JSON')
  // optsWithGlobals(): the parent `credits` command also declares --json, which
  // commander binds to the parent - read merged opts so --json is seen here.
  .action((_opts, cmd: Command) => run('Plans', async () => {
    const opts = cmd.optsWithGlobals();
    // Plans + subscription are required; credit packs are best-effort - the plan
    // comparison must still render if /credits/products is unavailable (e.g.
    // credit packs aren't configured in this environment).
    const [plansRes, subRes] = await Promise.all([
      get<{ data: PlanRow[] }>('/plans'),
      get<{ data: SubscriptionData }>('/credits/subscription'),
    ]);
    const products = await get<{ data: ProductEntry[] }>('/credits/products')
      .then(r => r.data).catch(() => [] as ProductEntry[]);
    if (opts.json) {
      console.log(JSON.stringify({ currentTier: subRes.data.tier, plans: plansRes.data, products }));
      return;
    }
    const currentTier = subRes.data.tier;
    const plans = plansRes.data;
    if (plans.length === 0) {
      console.log('No active plans.');
      return;
    }
    console.log(bold('Plans'));
    for (const plan of plans) {
      const marker = plan.tier === currentTier ? brand('* ') : '  ';
      const price = plan.monthlyPriceUsd > 0 ? ` - $${plan.monthlyPriceUsd}/mo` : ' - Free';
      const credits = plan.monthlyCredits > 0
        ? ` - ${plan.monthlyCredits.toLocaleString()} credits/mo (${plan.creditExpiryDays}-day expiry)`
        : '';
      console.log(`${marker}${plan.displayName} (${plan.tier})${price}${credits}`);
      renderLimits(plan.limits, '      ');
      console.log('');
    }

    const packs = products.filter(p => p.type === 'one_time');
    if (packs.length > 0) {
      console.log(bold('Credit packs') + muted('  (require an active Pro subscription)'));
      for (const pack of packs) {
        const lock = pack.available ? '' : muted('  [Pro only]');
        console.log(`  ${pack.name} - $${pack.amountUsd} - ${pack.credits.toLocaleString()} credits${lock}`);
      }
      console.log('');
    }

    console.log(dim('* = your current plan.  Upgrade or top up with `gipity credits buy [pro|<pack-credits>]`.'));
  }));

// `credits buy` is the ONE purchase command. It resolves the target to a
// Stripe price and prints a checkout link (agent-friendly: the link is always
// printed so it can be relayed to the user; --open also launches a browser).
creditsCommand
  .command('buy [target]')
  .alias('upgrade')
  .description('Upgrade your plan or buy a credit pack (target: a tier like "pro", or a pack credit amount)')
  .option('--open', 'Open the checkout page in your browser')
  .option('--json', 'Output the checkout URL as JSON')
  // optsWithGlobals(): the parent `credits` command also declares --json, which
  // commander binds to the parent - read merged opts so --json/--open are seen here.
  .action((target: string | undefined, _opts, cmd: Command) => run('Buy', async () => {
    const opts = cmd.optsWithGlobals();
    const subRes = await get<{ data: SubscriptionData }>('/credits/subscription');
    // Products are best-effort: if the catalog is unavailable we can't build a
    // direct checkout link, so we fall back to the pricing page below rather
    // than erroring out.
    const products = await get<{ data: ProductEntry[] }>('/credits/products')
      .then(r => r.data).catch(() => [] as ProductEntry[]);
    const currentTier = subRes.data.tier;

    // Resolve the target product. With no arg, default to the first available
    // paid subscription (the upgrade path). With an arg, match a plan/pack by
    // name or credit amount, mirroring the cloud agent's product keys.
    // Non-happy exits must stay parseable under --json (agents rely on it), so
    // emit a JSON { error } instead of prose when the flag is set.
    const bail = (message: string, humanLines: string[]): void => {
      if (opts.json) console.log(JSON.stringify({ error: message }));
      else for (const line of humanLines) console.log(line);
    };

    let product: ProductEntry | undefined;
    if (!target) {
      product = products.find(p => p.type === 'subscription' && p.available);
      if (!product) {
        bail(
          currentTier === 'pro'
            ? "You're already on Gipity Pro. To top up credits, run `gipity credits list` and buy a pack, e.g. `gipity credits buy 20000`."
            : 'No upgrade plan is available right now.',
          [
            currentTier === 'pro'
              ? `You're already on ${brand('Gipity Pro')}. To top up credits, run \`gipity credits list\` and buy a pack, e.g. \`gipity credits buy 20000\`.`
              : 'No upgrade plan is available right now.',
            dim(`Browse everything at ${PRICING_URL}`),
          ],
        );
        return;
      }
    } else {
      const key = target.toLowerCase();
      product = products.find(p => p.type === 'subscription' && p.name.toLowerCase() === key)
        // pack keyed by credit amount, e.g. "20000" - MUST be a pack, not a
        // subscription (Pro's monthly_credits can equal a pack's credit count).
        ?? products.find(p => p.type === 'one_time' && String(p.credits) === key)
        // accept "pro" against the single paid plan when only one exists
        ?? (key === 'pro' ? products.find(p => p.type === 'subscription') : undefined);
      if (!product) {
        bail(`Unknown option "${target}". Run \`gipity credits list\` to see plans and packs.`,
          [`Unknown option "${target}". Run \`gipity credits list\` to see plans and packs.`]);
        return;
      }
      if (!product.available) {
        bail(
          product.type === 'subscription'
            ? `You're already on ${product.name}.`
            : 'Credit packs require an active Pro subscription. Run `gipity credits buy pro` first.',
          [product.type === 'subscription'
            ? `You're already on ${brand(product.name)}.`
            : 'Credit packs require an active Pro subscription. Run `gipity credits buy pro` first.'],
        );
        return;
      }
    }

    try {
      const res = await post<{ data: CheckoutData }>('/credits/purchase', { priceId: product.priceId });
      const url = res.data.checkoutUrl;
      if (opts.json) {
        console.log(JSON.stringify({ product: product.name, amountUsd: product.amountUsd, checkoutUrl: url }));
        return;
      }
      const verb = product.type === 'subscription' ? 'Upgrading to' : 'Buying';
      const per = product.type === 'subscription' ? '/mo' : '';
      console.log(`${verb} ${brand(product.name)} ${muted(`($${product.amountUsd}${per}, ${product.credits.toLocaleString()} credits)`)}`);
      console.log('');
      console.log(`  ${bold('Checkout:')} ${success(url)}`);
      console.log('');
      console.log(dim('Open the link to complete your purchase — 2 minutes, cancel anytime. Your plan unlocks the moment payment clears.'));
      if (opts.open) openInBrowser(url);
    } catch (err) {
      // Payments not configured / Stripe hiccup: fall back to the pricing page
      // so the user is never dead-ended.
      if (err instanceof ApiError) {
        if (opts.json) {
          console.log(JSON.stringify({ error: err.message, checkoutUrl: null, fallbackUrl: PRICING_URL }));
        } else {
          console.log(muted(`Couldn't create a direct checkout link (${err.message}).`));
          console.log(`Complete your purchase at ${brand(PRICING_URL)}`);
        }
        if (opts.open) openInBrowser(PRICING_URL);
        return;
      }
      throw err;
    }
  }));

// `credits manage` is the ONE manage/cancel command: it mints a Stripe
// Customer Portal link (cancel at period end, renew, update card, invoices).
// Like `buy`, the link is always printed so an agent can relay it; --open
// also launches a browser. Falls back to the pricing page on error.
creditsCommand
  .command('manage')
  .alias('cancel')
  .description('Manage or cancel your subscription (opens the Stripe billing portal)')
  .option('--open', 'Open the billing portal in your browser')
  .option('--json', 'Output the portal URL as JSON')
  // optsWithGlobals(): the parent `credits` command also declares --json, which
  // commander binds to the parent - read merged opts so --json/--open are seen here.
  .action((_opts, cmd: Command) => run('Manage', async () => {
    const opts = cmd.optsWithGlobals();
    try {
      const res = await post<{ data: { portalUrl: string } }>('/credits/portal', {});
      const url = res.data.portalUrl;
      if (opts.json) {
        console.log(JSON.stringify({ portalUrl: url }));
        return;
      }
      console.log(`  ${bold('Billing portal:')} ${success(url)}`);
      console.log('');
      console.log(dim('Open the link to cancel, renew, update your card, or view invoices. Cancelling takes effect at the end of the billing period — you keep your credits.'));
      if (opts.open) openInBrowser(url);
    } catch (err) {
      // No billing account / payments not configured: point at the pricing page
      // so the user is never dead-ended.
      if (err instanceof ApiError) {
        if (opts.json) {
          console.log(JSON.stringify({ error: err.message, portalUrl: null, fallbackUrl: PRICING_URL }));
        } else {
          console.log(muted(`Couldn't open the billing portal (${err.message}).`));
          console.log(`Manage your plan at ${brand(PRICING_URL)}`);
        }
        if (opts.open) openInBrowser(PRICING_URL);
        return;
      }
      throw err;
    }
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

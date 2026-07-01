import { Command } from 'commander';
import { get } from '../api.js';
import { brand, dim } from '../colors.js';
import { run } from '../helpers/index.js';

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

interface LimitsResponse {
  tier: string;
  planAppliedAt: string | null;
  limits: Record<string, unknown>;
}

const LIMIT_LABELS: Record<string, string> = {
  maxDatabases: 'Databases',
  storageQuotaBytes: 'Storage',
  maxWorkflows: 'Workflows',
  minCronIntervalHours: 'Cron frequency',
  maxConcurrentChats: 'Concurrent chats',
  deployRatePerMinute: 'Deploys/min',
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

function renderLimits(limits: Record<string, unknown>, indent = ''): void {
  for (const key of Object.keys(LIMIT_LABELS)) {
    const value = limits[key];
    if (value !== undefined) {
      console.log(`${indent}${LIMIT_LABELS[key].padEnd(18)} ${formatLimit(key, value)}`);
    }
  }
}

export const planCommand = new Command('plan')
  .description('Show your plan')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Plan', async () => {
    const [limitsRes, plansRes] = await Promise.all([
      get<{ data: LimitsResponse }>('/users/me/limits'),
      get<{ data: PlanRow[] }>('/plans'),
    ]);
    if (opts.json) {
      console.log(JSON.stringify({ user: limitsRes.data, plans: plansRes.data }));
      return;
    }
    const { tier, planAppliedAt, limits } = limitsRes.data;
    const plan = plansRes.data.find(p => p.tier === tier);
    if (plan) {
      const price = plan.monthlyPriceUsd > 0 ? `  $${plan.monthlyPriceUsd}/mo` : '';
      console.log(`Plan: ${brand(plan.displayName)} (${plan.tier})${price}`);
      if (plan.monthlyCredits > 0) {
        console.log(`${plan.monthlyCredits.toLocaleString()} credits/mo, ${plan.creditExpiryDays}-day expiry`);
      }
    } else {
      console.log(`Plan: ${tier} (no matching plan row)`);
    }
    if (planAppliedAt) {
      console.log(`${dim('Applied: ' + new Date(planAppliedAt).toLocaleDateString())}`);
    }
    console.log('\nLimits:');
    renderLimits(limits);
  }));

planCommand
  .command('list', { isDefault: false })
  .description('List all available plans and their limits')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Plans', async () => {
    const [plansRes, limitsRes] = await Promise.all([
      get<{ data: PlanRow[] }>('/plans'),
      get<{ data: LimitsResponse }>('/users/me/limits'),
    ]);
    if (opts.json) {
      console.log(JSON.stringify(plansRes.data));
      return;
    }
    const currentTier = limitsRes.data.tier;
    if (plansRes.data.length === 0) {
      console.log('No active plans.');
      return;
    }
    for (const plan of plansRes.data) {
      const marker = plan.tier === currentTier ? brand('* ') : '  ';
      const price = plan.monthlyPriceUsd > 0 ? ` - $${plan.monthlyPriceUsd}/mo` : ' - Free';
      const credits = plan.monthlyCredits > 0
        ? ` - ${plan.monthlyCredits.toLocaleString()} credits/mo (${plan.creditExpiryDays}-day expiry)`
        : '';
      console.log(`${marker}${plan.displayName} (${plan.tier})${price}${credits}`);
      renderLimits(plan.limits);
      console.log('');
    }
    console.log(dim('(* = your current plan)'));
  }));

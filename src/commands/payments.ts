import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';
import { brand, bold, dim, muted } from '../colors.js';
import { run } from '../helpers/index.js';

interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

function renderStatus(status: ConnectStatus): void {
  if (!status.connected) {
    console.log('Stripe: not connected. Run `gipity payments connect` to set it up.');
    return;
  }
  const charges = status.charges_enabled ? brand('enabled') : dim('disabled');
  const payouts = status.payouts_enabled ? brand('enabled') : dim('disabled');
  console.log(`Stripe: ${bold('connected')}`);
  console.log(`  Charges:  ${charges}`);
  console.log(`  Payouts:  ${payouts}`);
  console.log(`  Onboarding: ${status.details_submitted ? 'complete' : 'incomplete'}`);
  if (!status.charges_enabled) {
    console.log(muted('\nCharges are not enabled yet — finish Stripe onboarding via `gipity payments connect`.'));
  }
}

export const paymentsCommand = new Command('payments')
  .description('Connect Stripe so your app can charge its users (one-time + subscriptions)');

paymentsCommand
  .command('connect')
  .description('Start (or resume) Stripe onboarding for this app — prints a link to finish in your browser')
  .option('--return-url <url>', 'Where Stripe redirects after onboarding')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Payments', async () => {
    const config = requireConfig();
    const body = opts.returnUrl ? { returnUrl: opts.returnUrl } : {};
    const res = await post<{ data: { url: string; connectedAccountId: string; status: ConnectStatus } }>(
      `/api/${config.projectGuid}/services/payments/connect`,
      body,
    );
    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }
    console.log('Open this link to connect your Stripe account (bank + identity; no API keys to paste):\n');
    console.log(brand(res.data.url));
    console.log(muted('\nMoney lands in your Stripe account; Gipity takes a small platform fee.'));
    console.log(muted('When done, run `gipity payments status` to confirm charges are enabled.'));
  }));

paymentsCommand
  .command('status', { isDefault: true })
  .description('Show whether this app can take payments yet')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Payments', async () => {
    const config = requireConfig();
    const res = await get<{ data: ConnectStatus }>(`/api/${config.projectGuid}/services/payments/status`);
    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }
    renderStatus(res.data);
  }));

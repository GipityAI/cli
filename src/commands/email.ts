import { Command, Option } from 'commander';
import { get, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { success, bold, muted, warning } from '../colors.js';
import { run } from '../helpers/index.js';

// `email` is a command GROUP for the deployed app's email() service:
// `email test` sends through it, `email log` lists recent sends.
export const emailCommand = new Command('email')
  .description("Test and inspect a deployed app's email() sends");

// --- gipity email test <to> ---
// Exercises the deployed app's email() send path (platform-brokered, owner-billed)
// so the agent can verify email works after deploy — the parallel of `notify test`.
emailCommand
  .command('test')
  .description("Send a test email through your app's email() path (owner-billed)")
  .argument('<to>', 'Recipient address')
  .option('--subject <text>', 'Subject', 'Test email from Gipity')
  .option('--text <text>', 'Body text', 'This is a test email sent through your app\'s email() service. ✉️')
  .option('--reply-to <email>', 'Reply-To address')
  .option('--from-name <name>', 'Sender display name (address stays gipity@gipity.ai)')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((to, opts) => run('Email', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const payload: Record<string, unknown> = { to, subject: opts.subject, text: opts.text };
    if (opts.replyTo) payload.replyTo = opts.replyTo;
    if (opts.fromName) payload.fromName = opts.fromName;

    const res = await post<{ data: { sent: number; skipped: number; results: { to: string; status: string; reason?: string }[] } }>(
      `/api/${config.projectGuid}/services/email/send`, payload,
    );

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { sent, skipped, results } = res.data;
    if (sent > 0) console.log(success(`✓ Sent to ${sent} recipient${sent === 1 ? '' : 's'}.`));
    else console.log(warning(`Nothing sent (${skipped} skipped).`));
    for (const r of results) {
      console.log(muted(`  ${r.to} - ${r.status}${r.reason ? `: ${r.reason}` : ''}`));
    }
  }));

// --- gipity email log ---
// Recent email() activity from the credits ledger: delivered sends
// (operation = email_send) plus skipped attempts (email_skip, 0-credit rows
// recording unsubscribed/blocked/not-configured recipients).
emailCommand
  .command('log')
  .description('Recent email() sends and skipped attempts from your app')
  .addOption(new Option('--range <range>', 'Time range').choices(['1h', '24h', '7d', '30d', '1y']).default('7d'))
  .option('--limit <n>', 'Max rows', '50')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Email', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await get<{ data: { totals: { n: number; credits: number }; items: Array<{ created_at: string; credits_deducted: string; detail: { to?: string; subject?: string; status?: string } | null }> } }>(
      `/account/logs/credits?operations=email_send,email_skip&app_guid=${config.projectGuid}&range=${encodeURIComponent(opts.range)}&limit=${encodeURIComponent(opts.limit)}`,
    );

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { totals, items } = res.data;
    if (!items.length) { console.log(muted('No email() activity in this range (sends and skipped attempts both appear here).')); return; }
    console.log(bold(`${totals.n} attempt${totals.n === 1 ? '' : 's'} · ${totals.credits} credit${totals.credits === 1 ? '' : 's'}`));
    for (const r of items) {
      const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16);
      const to = r.detail?.to ?? '-';
      const subj = r.detail?.subject ? ` · ${r.detail.subject}` : '';
      const status = r.detail?.status ? ` [skipped: ${r.detail.status}]` : '';
      console.log(`  ${muted(when)}  ${to}${status ? warning(status) : ''}${muted(subj)}`);
    }
  }));

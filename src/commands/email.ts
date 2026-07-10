import { Command } from 'commander';
import { get, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { error as clrError, success, bold, muted, warning } from '../colors.js';
import { run } from '../helpers/index.js';

/** Commander collector: build an array from repeated flags (--to a --to b). */
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export const emailCommand = new Command('email')
  .description('Send email (as the agent), or test/inspect a deployed app\'s email() sends')
  .addHelpText('after', [
    '',
    'Agent email (default): sends from gipity@gipity.ai. Omit --to to self-send.',
    'App email():',
    '  gipity email test <to>   Send a test email through your app\'s email() path (owner-billed)',
    '  gipity email log         Recent email() sends from your app',
  ].join('\n'))
  .requiredOption('--subject <subject>', 'Email subject')
  .requiredOption('--body <body>', 'Email body (plain text)')
  .option('--to <email>', 'Recipient (repeatable; omit for self-send)', collect, [] as string[])
  .option('--cc <email>', 'Cc recipient (repeatable)', collect, [] as string[])
  .option('--bcc <email>', 'Bcc recipient (repeatable)', collect, [] as string[])
  .option('--reply-to <email>', 'Reply-To header address')
  .option('--html <html>', 'Optional HTML body')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      await resolveProjectContext();
      const payload: Record<string, unknown> = {
        subject: opts.subject,
        body: opts.body,
      };
      if (opts.to.length) payload.to = opts.to;
      if (opts.cc.length) payload.cc = opts.cc;
      if (opts.bcc.length) payload.bcc = opts.bcc;
      if (opts.replyTo) payload.reply_to = opts.replyTo;
      if (opts.html) payload.html = opts.html;

      const res = await post<{ data: { to: string[]; cc: string[]; bcc: string[]; subject: string } }>(
        '/agent-email/send', payload,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        const recap = res.data.to.join(', ')
          + (res.data.cc.length ? `, cc: ${res.data.cc.join(', ')}` : '')
          + (res.data.bcc.length ? `, bcc: ${res.data.bcc.length}` : '');
        console.log(success(`Email sent to ${recap}: ${res.data.subject}`));
      }
    } catch (err: any) {
      console.error(clrError(`Email failed: ${err.message}`));
      process.exit(1);
    }
  });

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

    const res = await post<{ data: { sent: number; skipped: number; results: { to: string; status: string }[] } }>(
      `/api/${config.projectGuid}/services/email/send`, payload,
    );

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { sent, skipped, results } = res.data;
    if (sent > 0) console.log(success(`✓ Sent to ${sent} recipient${sent === 1 ? '' : 's'}.`));
    else console.log(warning(`Nothing sent (${skipped} skipped).`));
    for (const r of results) console.log(muted(`  ${r.to} — ${r.status}`));
  }));

// --- gipity email log ---
// Recent email() sends from the credits ledger (operation = email_send).
emailCommand
  .command('log')
  .description('Recent email() sends from your app')
  .option('--range <range>', 'Time range (24h, 7d, 30d)', '7d')
  .option('--limit <n>', 'Max rows', '50')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Email', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await get<{ data: { totals: { n: number; credits: number }; items: Array<{ created_at: string; credits_deducted: string; detail: { to?: string; subject?: string } | null }> } }>(
      `/account/logs/credits?operations=email_send&app_guid=${config.projectGuid}&range=${encodeURIComponent(opts.range)}&limit=${encodeURIComponent(opts.limit)}`,
    );

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { totals, items } = res.data;
    if (!items.length) { console.log(muted('No email() sends in this range.')); return; }
    console.log(bold(`${totals.n} send${totals.n === 1 ? '' : 's'} · ${totals.credits} credit${totals.credits === 1 ? '' : 's'}`));
    for (const r of items) {
      const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16);
      const to = r.detail?.to ?? '—';
      const subj = r.detail?.subject ? ` · ${r.detail.subject}` : '';
      console.log(`  ${muted(when)}  ${to}${muted(subj)}`);
    }
  }));

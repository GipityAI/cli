import { Command } from 'commander';
import { get, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { bold, muted, success, warning } from '../colors.js';
import { run } from '../helpers/index.js';

export const notifyCommand = new Command('notify')
  .description('Gipity Notify (web push): send a test notification or inspect subscriptions');

notifyCommand
  .command('test')
  .description('Send a test push notification to yourself, a user, or everyone')
  .option('--to <who>', "Recipient: a user guid, comma-separated guids, or 'all'", 'all')
  .option('--title <text>', 'Notification title', 'Test notification')
  .option('--body <text>', 'Notification body', 'Hello from Gipity Notify 👋')
  .option('--url <url>', 'URL to open when the notification is clicked')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const to = opts.to === 'all' ? 'all' : (opts.to.includes(',') ? opts.to.split(',').map((s: string) => s.trim()) : opts.to);
    const notification: Record<string, string> = { title: opts.title, body: opts.body };
    if (opts.url) notification.url = opts.url;

    const res = await post<{ data: { sent: number; failed: number; pruned: number } }>(
      `/api/${config.projectGuid}/services/notify/send`,
      { to, notification },
    );

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { sent, failed, pruned } = res.data;
    if (sent > 0) console.log(success(`✓ Sent to ${sent} device${sent === 1 ? '' : 's'}.`));
    else console.log(warning('No devices received it — has anyone enabled notifications in the app yet? (gipity notify subs)'));
    if (pruned) console.log(muted(`  pruned ${pruned} expired subscription${pruned === 1 ? '' : 's'}`));
    if (failed) console.log(muted(`  ${failed} delivery failure${failed === 1 ? '' : 's'}`));
  }));

notifyCommand
  .command('subs')
  .description('Show how many push subscriptions this app has, per user')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await get<{ data: { total: number; byUser: { user_guid: string; count: number }[] } }>(
      `/api/${config.projectGuid}/services/notify/subs`,
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { total, byUser } = res.data;
    console.log(bold(`${total} subscription${total === 1 ? '' : 's'} across ${byUser.length} user${byUser.length === 1 ? '' : 's'}`));
    for (const r of byUser) console.log(`  ${r.user_guid}  ${muted(`${r.count} device${r.count === 1 ? '' : 's'}`)}`);
  }));

notifyCommand
  .command('rm')
  .description("Remove a user's push subscriptions (e.g. on account deletion)")
  .requiredOption('--user <guid>', 'User guid whose subscriptions to remove')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await post<{ data: { removed: number } }>(
      `/api/${config.projectGuid}/services/notify/remove`,
      { user_guid: opts.user },
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(success(`Removed ${res.data.removed} subscription${res.data.removed === 1 ? '' : 's'} for ${opts.user}.`));
  }));

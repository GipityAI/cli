import { Command } from 'commander';
import { readFileSync } from 'fs';
import { get, post, put, del } from '../api.js';
import { bold, muted, success, warning } from '../colors.js';
import { run, PROJECT_OPTION, projectGuidFor } from '../helpers/index.js';

export const notifyCommand = new Command('notify')
  .description('Push notifications (web and native iOS)')
  .addHelpText('after', '\nGipity Notify: send a test notification, inspect subscriptions, or set up iOS push (notify apns).');

notifyCommand
  .command('test')
  .description('Send a test push notification (web and iOS devices) to a user or everyone')
  .option('--to <who>', "Recipient: a user guid, comma-separated guids, or 'all'", 'all')
  .option('--title <text>', 'Notification title', 'Test notification')
  .option('--body <text>', 'Notification body', 'Hello from Gipity Notify 👋')
  .option('--url <url>', 'URL to open when the notification is clicked')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const projectGuid = await projectGuidFor(opts);
    const to = opts.to === 'all' ? 'all' : (opts.to.includes(',') ? opts.to.split(',').map((s: string) => s.trim()) : opts.to);
    const notification: Record<string, string> = { title: opts.title, body: opts.body };
    if (opts.url) notification.url = opts.url;

    const res = await post<{ data: { sent: number; failed: number; pruned: number; results: DeliveryResult[] } }>(
      `/api/${projectGuid}/services/notify/send`,
      { to, notification },
    );

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { sent, failed, pruned, results } = res.data;
    if (sent > 0) {
      const ios = results.filter(r => r.transport === 'apns' && r.status === 'sent').length;
      const web = sent - ios;
      const split = ios > 0 ? ` (${web} web, ${ios} iOS)` : '';
      console.log(success(`✓ Sent to ${sent} device${sent === 1 ? '' : 's'}${split}.`));
    } else {
      console.log(warning('No devices received it: has anyone enabled notifications in the app yet? (gipity notify subs)'));
    }
    if (pruned) console.log(muted(`  pruned ${pruned} expired subscription${pruned === 1 ? '' : 's'}`));
    if (failed) {
      console.log(muted(`  ${failed} delivery failure${failed === 1 ? '' : 's'}`));
      for (const r of results) {
        if (r.status === 'failed' && r.transport === 'apns') console.log(muted(`    iOS device ...${r.device}: ${r.reason ?? 'failed'}`));
      }
    }
  }));

notifyCommand
  .command('subs')
  .description('Show how many push subscriptions this app has, per user')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const projectGuid = await projectGuidFor(opts);
    const res = await get<{ data: { total: number; byUser: { user_guid: string; count: number; web: number; ios: number }[] } }>(
      `/api/${projectGuid}/services/notify/subs`,
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { total, byUser } = res.data;
    console.log(bold(`${total} subscription${total === 1 ? '' : 's'} across ${byUser.length} user${byUser.length === 1 ? '' : 's'}`));
    for (const r of byUser) {
      const split = r.ios > 0 ? ` (${r.web} web, ${r.ios} iOS)` : '';
      console.log(`  ${r.user_guid}  ${muted(`${r.count} device${r.count === 1 ? '' : 's'}${split}`)}`);
    }
  }));

notifyCommand
  .command('rm')
  .description("Remove a user's push subscriptions and iOS devices (e.g. on account deletion)")
  .requiredOption('--user <guid>', 'User guid whose subscriptions to remove')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const projectGuid = await projectGuidFor(opts);
    const res = await post<{ data: { removed: number } }>(
      `/api/${projectGuid}/services/notify/remove`,
      { user_guid: opts.user },
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(success(`Removed ${res.data.removed} subscription${res.data.removed === 1 ? '' : 's'} for ${opts.user}.`));
  }));

// --- notify apns: the app's own Apple push key (native iOS apps) ---

type DeliveryResult =
  | { transport: 'web'; endpoint: string; status: string }
  | { transport: 'apns'; device: string; status: string; reason?: string };

interface ApnsConfig {
  configured: boolean;
  teamId?: string;
  keyId?: string;
  bundleId?: string;
  defaultEnvironment?: 'production' | 'sandbox';
}

function printApns(c: ApnsConfig): void {
  if (!c.configured) {
    console.log(warning('iOS push is not set up. Run: gipity notify apns set --team-id <id> --key-id <id> --p8 <AuthKey.p8> --bundle-id <id>'));
    return;
  }
  console.log(`  Team ID:    ${c.teamId}`);
  console.log(`  Key ID:     ${c.keyId}`);
  console.log(`  Bundle ID:  ${c.bundleId}`);
  console.log(`  Default:    ${c.defaultEnvironment} ${muted('(for devices that register without an environment)')}`);
}

export const apnsCommand = new Command('apns')
  .description('Set up push notifications for a native iOS app (your own Apple key)')
  .addHelpText('after', `
Create an APNs key in your Apple Developer account (Certificates, Identifiers
& Profiles > Keys > + > Apple Push Notifications service), download the
AuthKey_<KEYID>.p8 file, then:

  gipity notify apns set --team-id ABCDE12345 --key-id KEY1234567 \\
    --p8 ./AuthKey_KEY1234567.p8 --bundle-id com.example.myapp

The key is stored encrypted and never shown again. Your app registers each
device with POST /api/<app-guid>/notify/devices; notify() then reaches it.`);

apnsCommand
  .command('set')
  .description('Store the APNs key for this app (all environments use it)')
  .requiredOption('--team-id <id>', 'Your 10-character Apple Team ID')
  .requiredOption('--key-id <id>', 'The 10-character Key ID of the APNs key')
  .requiredOption('--p8 <file>', 'Path to the AuthKey_<KEYID>.p8 file')
  .requiredOption('--bundle-id <id>', 'Your app bundle id, e.g. com.example.myapp')
  .option('--sandbox', 'Devices that register without an environment use the sandbox (development builds)')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const projectGuid = await projectGuidFor(opts);
    let p8: string;
    try {
      p8 = readFileSync(opts.p8, 'utf-8');
    } catch {
      throw new Error(`Can't read ${opts.p8}. Pass the path to the AuthKey_<KEYID>.p8 file from Apple.`);
    }
    const res = await put<{ data: ApnsConfig }>(`/api/${projectGuid}/services/notify/apns`, {
      team_id: opts.teamId, key_id: opts.keyId, bundle_id: opts.bundleId, p8, sandbox: !!opts.sandbox,
    });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(success('✓ iOS push is set up.'));
    printApns(res.data);
  }));

apnsCommand
  .command('show')
  .description('Show the APNs setup for this app (never the key itself)')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const projectGuid = await projectGuidFor(opts);
    const res = await get<{ data: ApnsConfig }>(`/api/${projectGuid}/services/notify/apns`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    printApns(res.data);
  }));

apnsCommand
  .command('rm')
  .description('Remove the APNs key (iOS devices stop receiving notifications)')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Notify', async () => {
    const projectGuid = await projectGuidFor(opts);
    const res = await del<{ data: { removed: boolean } }>(`/api/${projectGuid}/services/notify/apns`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(res.data.removed ? success('✓ APNs key removed.') : warning('No APNs key was set.'));
  }));

notifyCommand.addCommand(apnsCommand);

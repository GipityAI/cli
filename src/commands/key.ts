import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { bold, muted, success, warning } from '../colors.js';
import { run, printList } from '../helpers/index.js';

/**
 * Project API keys - the revocable secret a script, cron, or agent sends as
 * `X-Api-Key` to write to YOUR app without a browser login.
 *
 * These are per-project and app-facing; `gipity token` mints account-level
 * agent tokens (gip_at_*) that drive the CLI itself. Without this command the
 * only mint path was raw curl, so agents asked for "a key I can generate and
 * revoke" built their own key table instead of using the platform's.
 */
export const keyCommand = new Command('key')
  .description('Manage project API keys for scripts and agents (X-Api-Key)')
  .addHelpText('after', `
Give a script, cron, or agent write access to your app without a login:

  gipity key create "laptop importer" --role editor
  # the script sends:  X-Api-Key: <the key printed once above>

Inside a function the caller shows up as ctx.auth.via === 'api_key' with
ctx.auth.apiKeyName set to the key's name - stamp that on rows to tell
script-written entries from hand-entered ones. Never build your own key table.

Account-level tokens that run the CLI headlessly are a different thing: see
gipity token --help.`);

interface KeyInfo {
  short_guid: string;
  name: string;
  prefix: string;
  role: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

const fmtDate = (d: string | null): string => (d ? new Date(d).toLocaleDateString() : 'never');

const projectOpt = ['--project <guid-or-slug>', 'Target a specific project instead of cwd / Home'] as const;

async function projectGuid(opts: { project?: string }): Promise<string> {
  const { config } = await resolveProjectContext({ projectOverride: opts.project });
  return config.projectGuid;
}

keyCommand
  .command('create <name>')
  .description('Mint a project API key (shown once). Give it a name you will recognize later')
  .option('--role <role>', 'viewer | editor | owner (default: viewer)', 'viewer')
  .option('--expires-days <n>', 'Days until the key expires (default: never)')
  .option(...projectOpt)
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Create', async () => {
    const body: { name: string; role: string; expires_in_days?: number } = { name, role: opts.role };
    if (opts.expiresDays !== undefined) {
      const days = parseInt(opts.expiresDays, 10);
      if (!Number.isFinite(days) || days <= 0) throw new Error('--expires-days must be a positive number of days');
      body.expires_in_days = days;
    }

    const res = await post<{ data: KeyInfo & { key: string } }>(
      `/projects/${await projectGuid(opts)}/api-keys`,
      body,
    );
    const k = res.data;

    if (opts.json) { console.log(JSON.stringify(k)); return; }

    const expNote = k.expires_at ? ` (expires ${fmtDate(k.expires_at)})` : ' (never expires)';
    console.log(success(`Created API key ${bold(k.short_guid)} "${k.name}" as ${k.role}${muted(expNote)}.`));
    console.log('');
    console.log(k.key);
    console.log('');
    console.log(muted('Send it from your script on every request:'));
    console.log(muted(`  curl -H "X-Api-Key: ${k.key}" ...`));
    console.log(muted(`Revoke it any time: gipity key revoke ${k.short_guid}`));
    console.log('');
    console.log(warning('Copy it now - it will not be shown again.'));
  }));

keyCommand
  .command('list')
  .alias('ls')
  .description('List this project\'s API keys (values are never shown again)')
  .option(...projectOpt)
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const res = await get<{ data: KeyInfo[] }>(`/projects/${await projectGuid(opts)}/api-keys`);
    printList(
      res.data,
      opts,
      'No API keys. Mint one with: gipity key create "my script" --role editor',
      (k) => `${bold(k.short_guid)}  ${k.name}  ${muted(`${k.role}  ${k.prefix}…  last used ${fmtDate(k.last_used_at)}  expires ${fmtDate(k.expires_at)}`)}`,
    );
  }));

keyCommand
  .command('revoke <short_guid>')
  .alias('rm')
  .description('Revoke a project API key (instant, irreversible)')
  .option(...projectOpt)
  .option('--json', 'Output as JSON')
  .action((shortGuid: string, opts) => run('Revoke', async () => {
    await del(`/projects/${await projectGuid(opts)}/api-keys/${encodeURIComponent(shortGuid)}`);
    if (opts.json) { console.log(JSON.stringify({ short_guid: shortGuid, revoked: true })); return; }
    console.log(success(`Revoked API key ${bold(shortGuid)}.`));
  }));

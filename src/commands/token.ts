import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { bold, muted, success, warning } from '../colors.js';
import { run, printList } from '../helpers/index.js';

export const tokenCommand = new Command('token')
  .description('Manage API tokens')
  .addHelpText('after', `
Long-lived agent API tokens (gip_at_*) for headless agents and CI - they drive
the gipity CLI as YOU.

To let a script or cron write to one app instead, mint a project API key:
gipity key create "my script" --role editor (sent as X-Api-Key).`);

interface TokenInfo {
  short_guid: string;
  name: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

const fmtDate = (d: string | null): string => (d ? new Date(d).toLocaleDateString() : 'never');

tokenCommand
  .command('create')
  .description('Mint a long-lived agent API token (shown once)')
  .option('--name <name>', 'Label for the token, e.g. "Hermes on my VPS"')
  .option('--expires <days>', 'Days until the token expires (default: never)')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Create', async () => {
    const body: { name?: string; expiresInDays?: number } = {};
    if (opts.name) body.name = opts.name;
    if (opts.expires !== undefined) {
      const days = parseInt(opts.expires, 10);
      if (!Number.isFinite(days) || days <= 0) throw new Error('--expires must be a positive number of days');
      body.expiresInDays = days;
    }

    const res = await post<{ data: { token: string; shortGuid: string; expiresAt: string | null } }>(
      '/auth/agent-tokens',
      body,
    );
    const { token, shortGuid, expiresAt } = res.data;

    if (opts.json) { console.log(JSON.stringify(res.data)); return; }

    const expNote = expiresAt ? ` (expires ${fmtDate(expiresAt)})` : ' (never expires)';
    console.log(success(`Created token ${bold(shortGuid)}${muted(expNote)}.`));
    console.log('');
    console.log(token);
    console.log('');
    console.log(muted('Use it from an agent, script, or CI — no login needed:'));
    console.log(`  export GIPITY_TOKEN=${token}`);
    console.log('');
    console.log(warning('Copy it now — it will not be shown again.'));
  }));

tokenCommand
  .command('list')
  .alias('ls')
  .description('List your active agent API tokens')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const res = await get<{ data: TokenInfo[] }>('/auth/agent-tokens');
    printList(res.data, opts, 'No agent API tokens.', (t) => {
      const label = t.name ? `  ${t.name}` : '';
      return `${bold(t.short_guid)}${label}  ${muted(`created ${fmtDate(t.created_at)}`)}  ${muted(`expires ${fmtDate(t.expires_at)}`)}  ${muted(`last used ${fmtDate(t.last_used_at)}`)}`;
    });
  }));

tokenCommand
  .command('revoke <short_guid>')
  .alias('rm')
  .description('Revoke an agent API token (instant, irreversible)')
  .option('--json', 'Output as JSON')
  .action((shortGuid: string, opts) => run('Revoke', async () => {
    await del<{ success: boolean }>(`/auth/agent-tokens/${encodeURIComponent(shortGuid)}`);
    if (opts.json) { console.log(JSON.stringify({ shortGuid, revoked: true })); return; }
    console.log(success(`Revoked token ${bold(shortGuid)}.`));
  }));

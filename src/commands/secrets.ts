import { Command } from 'commander';
import { get, put, del } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { bold, muted, success } from '../colors.js';
import { run } from '../helpers/index.js';

interface SecretMeta {
  name: string;
  preview: string | null;
  created_at: string;
  updated_at: string;
}

/** Build the query string for a scope. Account scope is project-independent;
 *  project scope needs the linked app's guid. */
async function scopeQuery(opts: { account?: boolean; project?: string }): Promise<string> {
  if (opts.account) return 'scope=account';
  const { config } = await resolveProjectContext({ projectOverride: opts.project });
  return `scope=project&app_guid=${config.projectGuid}`;
}

export const secretsCommand = new Command('secrets')
  .description('Manage app secrets')
  .addHelpText('after', '\nEncrypted API keys and tokens for your app, read in functions via secrets.get("NAME").');

secretsCommand
  .command('list')
  .alias('ls')
  .description('List secret names (never values). Project secrets by default; --account for account-wide')
  .option('--account', 'Account-wide secrets shared across all your projects')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Secrets', async () => {
    const res = await get<{ data: SecretMeta[] }>(`/secrets?${await scopeQuery(opts)}`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const scope = opts.account ? 'account-wide' : 'this project';
    if (res.data.length === 0) {
      console.log(muted(`No ${scope} secrets yet. Add one with: gipity secrets set NAME VALUE${opts.account ? ' --account' : ''}`));
      return;
    }
    console.log(bold(`${res.data.length} ${scope} secret${res.data.length === 1 ? '' : 's'}:`));
    for (const s of res.data) {
      const masked = s.preview ? muted(`...${s.preview}`) : muted('(hidden)');
      console.log(`  ${s.name}  ${masked}  ${muted(`updated ${new Date(s.updated_at).toLocaleDateString()}`)}`);
    }
  }));

secretsCommand
  .command('set <name> <value>')
  .description('Create or update a secret (UPPER_SNAKE_CASE name). Encrypted at rest; never echoed back')
  .option('--account', 'Store account-wide (shared across all your projects)')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((name, value, opts) => run('Secrets', async () => {
    const res = await put<{ data: SecretMeta }>(`/secrets?${await scopeQuery(opts)}`, { name, value });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const scope = opts.account ? 'account-wide' : 'this project';
    console.log(success(`✓ Secret '${res.data.name}' saved (encrypted, ${scope}). Read it in a function with secrets.get('${res.data.name}').`));
  }));

secretsCommand
  .command('rm <name>')
  .alias('delete')
  .description('Delete a secret')
  .option('--account', 'Delete from account-wide secrets')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((name, opts) => run('Secrets', async () => {
    const res = await del<{ data: { deleted: boolean } }>(`/secrets/${encodeURIComponent(name)}?${await scopeQuery(opts)}`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    if (res.data.deleted) console.log(success(`✓ Secret '${name}' deleted.`));
    else console.log(muted(`No secret named '${name}' found.`));
  }));

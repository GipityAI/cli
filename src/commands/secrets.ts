import { Command } from 'commander';
import { get, put, del } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { bold, muted, success } from '../colors.js';
import { run, PROJECT_OPTION } from '../helpers/index.js';

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
  .addHelpText('after', '\nEncrypted API keys and tokens for your app, read in functions via secrets.get("NAME").\nValues are write-only: no command prints a stored value back.');

secretsCommand
  .command('list')
  .alias('ls')
  .description('List secret names (never values). Project secrets by default; --account for account-wide')
  .option('--account', 'Account-wide secrets shared across all your projects')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Secrets', async () => {
    const res = await get<{ data: SecretMeta[] }>(`/secrets?${await scopeQuery(opts)}`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const scope = opts.account ? 'account-wide' : 'project';
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

// Secret values are write-only by design: they are decrypted only inside a
// running function (secrets.get), never returned to the CLI. `get` exists so an
// agent that reaches for it gets a clear refusal (stderr, exit 1) instead of an
// unknown-command line it might mistake for the value (platform#500).
secretsCommand
  .command('get <name>')
  .description('Secret values are write-only: confirms the secret exists, never prints its value')
  .option('--account', 'Look in account-wide secrets')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((name, opts) => run('Secrets', async () => {
    const res = await get<{ data: SecretMeta[] }>(`/secrets?${await scopeQuery(opts)}`);
    const scope = opts.account ? 'account-wide' : 'project';
    const found = res.data.find(s => s.name === name);
    if (!found) throw new Error(`No ${scope} secret named '${name}'. Values are write-only, so set it with: gipity secrets set ${name} VALUE${opts.account ? ' --account' : ''}`);
    const ends = found.preview ? ` (ends in ...${found.preview})` : '';
    throw new Error(
      `secret values are write-only and are never shown. '${name}' exists${ends}; only a deployed function can read it, with secrets.get('${name}'). `
      + `To hand a value to another service too, generate it yourself, keep it, then store it: `
      + `TOK=$(openssl rand -hex 24); gipity secrets set ${name} "$TOK"; echo "$TOK". Setting it again replaces the live value.`,
    );
  }));

secretsCommand
  .command('set <name> <value>')
  .description('Create or update a secret (UPPER_SNAKE_CASE name). Encrypted at rest; never echoed back')
  .option('--account', 'Store account-wide (shared across all your projects)')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((name, value, opts) => run('Secrets', async () => {
    const res = await put<{ data: SecretMeta }>(`/secrets?${await scopeQuery(opts)}`, { name, value });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const scope = opts.account ? 'account-wide' : 'project';
    console.log(success(`✓ Secret '${res.data.name}' saved (encrypted, ${scope}). Read it in a function with secrets.get('${res.data.name}').`));
  }));

secretsCommand
  .command('rm <name>')
  .alias('delete')
  .description('Delete a secret')
  .option('--account', 'Delete from account-wide secrets')
  .option(...PROJECT_OPTION)
  .option('--json', 'Output raw JSON')
  .action((name, opts) => run('Secrets', async () => {
    const res = await del<{ data: { deleted: boolean } }>(`/secrets/${encodeURIComponent(name)}?${await scopeQuery(opts)}`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    if (res.data.deleted) console.log(success(`✓ Secret '${name}' deleted.`));
    else console.log(muted(`No secret named '${name}' found.`));
  }));

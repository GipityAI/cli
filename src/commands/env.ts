import { Command } from 'commander';
import { get, post, patch, del } from '../api.js';
import { requireConfig, PROD_ENV } from '../config.js';
import { formatSize } from '../utils.js';
import { success, error as clrError, muted, bold, brand } from '../colors.js';
import { run } from '../helpers/index.js';
import { confirm } from '../utils.js';
import { withSpinner } from '../progress.js';

interface EnvSummary {
  name: string;
  guid: string;
  url: string;
  lastDeploy: string | null;
  schedules: boolean;
  dbBytes: number;
  customDomains: string[];
}

interface EnvList {
  app: { guid: string; name: string; slug: string };
  prod: { url: string };
  envs: EnvSummary[];
}

/** The app's guid: env commands always act on the app, whatever --env says. */
function appGuid(): string {
  return requireConfig().projectGuid;
}

export const envCommand = new Command('env')
  .description('App environments: prod plus any number of isolated copies (dev, staging, ...), each with its own database, functions and URL')
  .addHelpText('after', `
An environment is created the first time you deploy to it:
  gipity deploy dev           # creates "dev" (own DB from migrations, own functions), deploys
  gipity deploy prod          # the live app

Run any project command against one with --env:
  gipity db query "SELECT count(*) FROM orders" --env dev
  gipity fn call checkout --env staging
  gipity logs fn checkout --env dev

Envs share the app's secrets (an env can override one: gipity secrets set NAME value --env staging),
members and players. Cron workflows are off in an env until: gipity env set <name> --schedules on.
Email from an env reaches only the app owner and members; payments run in prod only.`);

envCommand
  .command('list', { isDefault: true })
  .description('List the app\'s environments')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Env', async () => {
    const res = await get<{ data: EnvList }>(`/projects/${appGuid()}/envs`);
    const d = res.data;
    if (opts.json) { console.log(JSON.stringify(d)); return; }
    console.log(`${bold('prod')}  ${brand(d.prod.url)}`);
    if (d.envs.length === 0) {
      console.log(muted('No environments yet. `gipity deploy dev` creates one.'));
      return;
    }
    for (const e of d.envs) {
      const deployed = e.lastDeploy ? `deployed ${new Date(e.lastDeploy).toLocaleString()}` : 'never deployed';
      const parts = [deployed, `DB ${formatSize(e.dbBytes)}`, e.schedules ? 'schedules on' : 'schedules off'];
      if (e.customDomains.length) parts.push(e.customDomains.join(', '));
      console.log(`${bold(e.name)}  ${brand(e.url)}  ${muted(parts.join(' · '))}`);
    }
  }));

envCommand
  .command('create <name>')
  .description('Create an environment and deploy the app to it (`gipity deploy <name>` does the same)')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Env', async () => {
    if (name === PROD_ENV) {
      console.error(clrError('prod is the app itself. Deploy it with: gipity deploy prod'));
      process.exit(1);
    }
    const create = () => post<{ data: { name: string; guid: string; url: string; phases: Array<{ name: string; status: string; summary: string }> } }>(
      `/projects/${appGuid()}/envs`, { name },
    );
    const res = opts.json ? await create() : await withSpinner(`Creating ${name}...`, create, { done: null });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const failed = res.data.phases.filter((p) => p.status === 'failed');
    for (const p of failed) console.log(`${clrError('✗')} ${bold(p.name)}: ${p.summary}`);
    if (failed.length > 0) {
      console.log(clrError(`Created ${name}, but its first deploy failed. Fix it and run: gipity deploy ${name}`));
      process.exit(1);
    }
    console.log(success(`✓ Created ${name}`));
    console.log(`${muted('Live:')} ${brand(res.data.url)}`);
  }));

envCommand
  .command('set <name>')
  .description('Change an environment\'s settings')
  .requiredOption('--schedules <on|off>', 'Turn the environment\'s cron workflows on or off')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Env', async () => {
    const value = String(opts.schedules).toLowerCase();
    if (value !== 'on' && value !== 'off') {
      console.error(clrError('--schedules takes on or off'));
      process.exit(1);
    }
    const res = await patch<{ data: { name: string; schedules: boolean } }>(`/projects/${appGuid()}/envs/${encodeURIComponent(name)}`, { schedules: value === 'on' });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(success(`✓ Schedules ${value} in ${name}`));
  }));

envCommand
  .command('delete <name>')
  .description('Delete an environment: its database, functions, files and custom domains (never prod)')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Env', async () => {
    if (name === PROD_ENV) {
      console.error(clrError('prod is the app itself and can\'t be deleted as an environment.'));
      process.exit(1);
    }
    const ok = await confirm(`Delete the ${bold(name)} environment and its database?`, { default: 'no' });
    if (!ok) { console.log(muted('Aborted.')); process.exit(1); }
    const res = await del<{ data: { deleted: string } }>(`/projects/${appGuid()}/envs/${encodeURIComponent(name)}`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(success(`✓ Deleted ${name}`));
  }));

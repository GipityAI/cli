import { Command } from 'commander';
import { get, put } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, muted, success, bold } from '../colors.js';
import { run, printResult } from '../helpers/index.js';

export type HostingOrigin = 'shared' | 'own';
const HOSTING_ORIGINS: HostingOrigin[] = ['shared', 'own'];

interface HostingStatus {
  hosting_origin: HostingOrigin;
  /** The app's own host (prod), or null when it has none. */
  own_host: string | null;
  /** Each environment's own host. */
  env_hosts: Record<string, string | null>;
  changed?: boolean;
}

function formatStatus(s: HostingStatus): string {
  const lines = [`Hosting: ${bold(s.hosting_origin)}`];
  if (s.own_host) lines.push(`Own host: https://${s.own_host}/`);
  for (const [env, host] of Object.entries(s.env_hosts)) {
    if (host) lines.push(`  ${env}: https://${host}/`);
  }
  lines.push('');
  if (s.hosting_origin === 'own') {
    lines.push(muted('Sign-in and API calls are first-party on the own host. a.gipity.ai ignores browser sign-in cookies for this app.'));
  } else {
    lines.push(muted('The app runs on the shared app.gipity.ai host. Try its own origin: gipity project hosting own'));
  }
  return lines.join('\n');
}

export function registerHostingCommand(projectCommand: Command): void {
  projectCommand
    .command('hosting [mode]')
    .description('Show or set where the app\'s pages sign people in: shared (app.gipity.ai) or own (its own gipity.app address)')
    .addHelpText('after', `
Modes:
  shared  The app runs on app.gipity.ai/<account>/<slug>/ (default).
  own     The app's own address, https://<slug>--<account>.gipity.app/ (envs on
          *.dev.gipity.app), answers its API under /__gipity/ with first-party
          sign-in that works in every browser, and the app's routes on
          a.gipity.ai stop accepting browser sign-in cookies. Deploy again after
          switching so the pages pick it up. Owner only.`)
    .option('--json', 'Output as JSON')
    .action((mode: string | undefined, opts) => run('Hosting', async () => {
      const config = requireConfig();
      if (mode === undefined) {
        const res = await get<{ data: HostingStatus }>(`/projects/${config.projectGuid}/hosting`);
        printResult(formatStatus(res.data), opts, res.data);
        return;
      }
      if (!HOSTING_ORIGINS.includes(mode as HostingOrigin)) {
        console.error(clrError(`Unknown mode "${mode}". Use one of: ${HOSTING_ORIGINS.join(', ')}.`));
        process.exit(1);
      }
      const res = await put<{ data: HostingStatus }>(`/projects/${config.projectGuid}/hosting`, { hosting_origin: mode });
      const head = res.data.changed
        ? success(`Hosting set to "${res.data.hosting_origin}". Deploy again (gipity deploy <env>) so the pages pick it up.`)
        : muted(`Hosting is already "${res.data.hosting_origin}".`);
      printResult(`${head}\n\n${formatStatus(res.data)}`, opts, res.data);
    }));
}

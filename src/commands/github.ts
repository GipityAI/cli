/**
 * `gipity github <connect|status|repos|disconnect>` - manage the GitHub
 * connection that powers `gipity load github:owner/repo`.
 *
 * Connect uses the GitHub App install flow: the URL is GitHub's own repo
 * picker, so the user chooses exactly which repositories Gipity can read.
 * Re-running connect doubles as the "grant more repositories" flow.
 */
import { Command } from 'commander';
import { get, post } from '../api.js';
import { brand, bold, muted } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';

interface GithubStatus {
  connected: boolean;
  email?: string | null;
  scopes?: string[];
  services?: Array<{ service: string; read: boolean; write: boolean }>;
  permissions?: Array<{ service: string; readEnabled: boolean; writeEnabled: boolean; writeRequiresApproval: boolean }>;
  connectedAt?: string;
}

interface GithubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  updated_at: string | null;
}

export const githubCommand = new Command('github')
  .description('Connect GitHub for repo imports')
  .addHelpText('after', '\nConnect once, then import any shared repo with `gipity load github:owner/repo`.');

githubCommand
  .command('connect')
  .description('Connect your GitHub account - prints a link; GitHub lets you pick which repositories to share')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Connect', async () => {
    const res = await get<{ url: string }>('/services/github/authorize');
    if (opts.json) {
      console.log(JSON.stringify({ url: res.url }));
      return;
    }
    console.log('Open this link in your browser to connect GitHub - GitHub lets you pick which repositories to share:\n');
    console.log(brand(res.url));
    console.log(muted('\nWhen done, run `gipity github status` to confirm.'));
    console.log(muted('Re-run `gipity github connect` any time to grant more repositories.'));
  }));

githubCommand
  .command('status', { isDefault: true })
  .description('Show whether GitHub is connected')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Status', async () => {
    const res = await get<{ data: GithubStatus }>('/services/github/status');
    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }
    const s = res.data;
    if (!s.connected) {
      console.log('GitHub: not connected. Run `gipity github connect` to set it up.');
      return;
    }
    console.log(`GitHub: ${bold('connected')}`);
    if (s.email) console.log(`  Account:   ${s.email}`);
    if (s.connectedAt) console.log(`  Connected: ${new Date(s.connectedAt).toLocaleDateString()}`);
    console.log(muted('\nList reachable repositories with `gipity github repos`.'));
    console.log(muted('Import one with `gipity load github:owner/repo`.'));
  }));

githubCommand
  .command('repos')
  .description('List the repositories your GitHub connection can reach')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Repos', async () => {
    const res = await get<{ data: GithubRepo[] }>('/services/github/repos').catch((err: any) => {
      if (err?.code === 'NOT_CONNECTED') {
        throw new Error('GitHub is not connected - run `gipity github connect` first.');
      }
      throw err;
    });
    const width = res.data.length ? Math.max(...res.data.map(r => r.full_name.length)) : 0;
    printList(res.data, opts, 'No repositories shared yet - run `gipity github connect` to grant some.', r => {
      const vis = r.private ? 'private' : 'public ';
      const desc = r.description ? `  ${muted(r.description)}` : '';
      return `${r.full_name.padEnd(width)}  ${muted(vis)}  ${r.default_branch}${desc}`;
    });
  }));

githubCommand
  .command('disconnect')
  .description('Disconnect GitHub (imports via github: sources will stop working)')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Disconnect', async () => {
    await post('/services/github/disconnect');
    printResult('GitHub disconnected.', opts, { disconnected: true });
  }));

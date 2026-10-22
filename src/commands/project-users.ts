import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { get, post, del } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, muted, success, bold } from '../colors.js';
import { confirm } from '../utils.js';
import { run, printResult } from '../helpers/index.js';

interface AppUser {
  guid: string;
  display_name: string | null;
  email: string | null;
  providers: string[];
  created_at: string;
  last_login_at: string | null;
}

interface AppUserPage {
  users: AppUser[];
  next_cursor: string | null;
  total: number;
}

const EXPORT_PAGE_SIZE = 500;

function fail(msg: string): never {
  console.error(clrError(msg));
  process.exit(1);
}

function usersPath(params: { search?: string; limit?: number; cursor?: string | null }): string {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const qs = q.toString();
  return `/projects/${requireConfig().projectGuid}/app-users${qs ? `?${qs}` : ''}`;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '-';
}

function formatTable(users: AppUser[]): string {
  const head = ['GUID', 'Name', 'Email', 'Providers', 'Created', 'Last sign-in'];
  const rows = users.map(u => [u.guid, u.display_name ?? '-', u.email ?? '-', u.providers.join(', ') || '-', day(u.created_at), day(u.last_login_at)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [bold(line(head)), ...rows.map(line)].join('\n');
}

/** One CSV field: quoted when it holds a comma, quote, or line break. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(users: AppUser[]): string {
  const cols = ['guid', 'display_name', 'email', 'providers', 'created_at', 'last_login_at'];
  const rows = users.map(u => [u.guid, u.display_name ?? '', u.email ?? '', u.providers.join(';'), u.created_at, u.last_login_at ?? '']);
  return [cols, ...rows].map(r => r.map(csvField).join(',')).join('\n') + '\n';
}

export function registerUsersCommand(projectCommand: Command): void {
  const users = projectCommand
    .command('users')
    .description("Manage the app's own users (app sign-in mode): list, export, delete, sign out")
    .addHelpText('after', `
These are the people who signed in to this app with Google, Apple, Discord, an
email code, Steam or a guest device. They belong to the app, not to Gipity.
  gipity project users --search ann         find users by name or email
  gipity project users export -o users.csv  every user, as CSV (or --format json)
  gipity project users delete <guid>        erase a user (runs the app's user_deleted hooks)
  gipity project users signout <guid>       end all of a user's web sessions`);

  users
    .command('list', { isDefault: true })
    .description("List the app's users")
    .option('--search <text>', 'Match name or email')
    .option('--limit <n>', 'How many to show (1-500, default 100)')
    .option('--json', 'Output as JSON')
    .action((opts) => run('Users', async () => {
      let limit: number | undefined;
      if (opts.limit !== undefined) {
        limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(`--limit takes a whole number from 1 to 500, not "${opts.limit}".`);
      }
      const res = await get<{ data: AppUserPage }>(usersPath({ search: opts.search, limit }));
      const d = res.data;
      if (opts.json) { console.log(JSON.stringify(d)); return; }
      if (d.users.length === 0) {
        console.log(muted(opts.search ? `No users match "${opts.search}".` : 'No users yet.'));
        return;
      }
      console.log(formatTable(d.users));
      console.log('');
      console.log(muted(`${d.users.length} of ${d.total} user${d.total === 1 ? '' : 's'}`));
      if (d.users.length < d.total) {
        console.log(muted('Narrow with --search, show more with --limit (up to 500), or get them all: gipity project users export'));
      }
    }));

  users
    .command('export')
    .description('Export every user of the app as CSV or JSON')
    .option('--format <format>', 'csv or json', 'csv')
    .option('-o, --output <file>', 'Write to this file instead of stdout')
    .option('--json', 'Output the result as JSON (with -o)')
    .action((opts) => run('Export', async () => {
      if (opts.format !== 'csv' && opts.format !== 'json') fail(`--format takes "csv" or "json", not "${opts.format}".`);
      const all: AppUser[] = [];
      let cursor: string | null = null;
      do {
        const res: { data: AppUserPage } = await get<{ data: AppUserPage }>(usersPath({ limit: EXPORT_PAGE_SIZE, cursor }));
        all.push(...res.data.users);
        cursor = res.data.next_cursor;
      } while (cursor);
      const out = opts.format === 'csv' ? toCsv(all) : JSON.stringify(all, null, 2) + '\n';
      if (!opts.output) { process.stdout.write(out); return; }
      writeFileSync(opts.output, out);
      printResult(success(`Exported ${all.length} user${all.length === 1 ? '' : 's'} to ${opts.output}.`), opts, { file: opts.output, count: all.length, format: opts.format });
    }));

  users
    .command('delete <userGuid>')
    .description("Erase a user and everything the app keeps for them (runs the app's user_deleted hooks)")
    .option('--json', 'Output as JSON')
    .action((userGuid: string, opts) => run('Delete', async () => {
      const ok = await confirm(`Delete user ${userGuid}? This erases the user and runs the app's user_deleted hooks to remove their data. It cannot be undone.`);
      if (!ok) { console.log('Cancelled.'); return; }
      const res = await del<{ data: { deleted: boolean } }>(`/projects/${requireConfig().projectGuid}/app-users/${encodeURIComponent(userGuid)}`);
      printResult(success(`Deleted user ${userGuid}.`), opts, { guid: userGuid, ...res.data });
    }));

  users
    .command('signout <userGuid>')
    .description("Sign a user out everywhere (revoke all of the user's web sessions)")
    .option('--json', 'Output as JSON')
    .action((userGuid: string, opts) => run('Sign out', async () => {
      const res = await post<{ data: { signed_out_sessions: number } }>(`/projects/${requireConfig().projectGuid}/app-users/${encodeURIComponent(userGuid)}/signout`);
      const n = res.data.signed_out_sessions;
      printResult(success(`Signed out ${userGuid}: ${n} session${n === 1 ? '' : 's'} ended.`), opts, { guid: userGuid, ...res.data });
    }));
}

import { Command } from 'commander';
import { get, post, put, patch, del, publicRequest, mintAppToken } from '../api.js';
import { getAuth } from '../auth.js';
import { requireConfig } from '../config.js';
import { bold, muted } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';
import { confirm } from '../utils.js';

// All commands hit the app API (https://a.gipity.ai/api/<guid>/records/...),
// which authorizes the logged-in owner via their Bearer token. (The native
// Records API is the only records surface that exists server-side; there is no
// /projects/<guid>/records mirror.)
export const recordsCommand = new Command('records')
  .description('Manage app records (Gipity Records - validated CRUD with audit history)');

const ANON_FLAG = '--anon';
const ANON_HELP =
  'Call as an anonymous visitor (the public path a signed-out user hits) instead of as your signed-in account';

/** One HTTP surface for every records subcommand, so `--anon` is a persona
 *  switch rather than a different code path. Anonymous calls mint the same
 *  short-lived app token the browser SDK uses and send no owner credentials -
 *  this is exactly what a signed-out visitor's request looks like, so a 401 here
 *  is the true answer for an auth-gated table. The persona goes to stderr so
 *  stdout stays parseable; without it, "verify the anonymous path" silently runs
 *  as the owner and the public path never gets exercised. */
async function recordsHttp(opts: { anon?: boolean }) {
  const config = requireConfig();
  if (!opts.anon) {
    const who = getAuth()?.email;
    console.error(muted(`Auth: calling as ${who ?? 'your signed-in account'} (the owner persona; use ${ANON_FLAG} for the public visitor path)`));
    return { guid: config.projectGuid, get, post, put, patch, del };
  }

  console.error(muted('Auth: anonymous visitor (the public path a signed-out user hits)'));
  const headers = await mintAppToken(config.projectGuid);
  return {
    guid: config.projectGuid,
    get: <T>(path: string) => publicRequest<T>('GET', path, undefined, headers),
    post: <T>(path: string, body?: unknown) => publicRequest<T>('POST', path, body, headers),
    put: <T>(path: string, body?: unknown) => publicRequest<T>('PUT', path, body, headers),
    patch: <T>(path: string, body?: unknown) => publicRequest<T>('PATCH', path, body, headers),
    del: <T>(path: string, body?: unknown) => publicRequest<T>('DELETE', path, body, headers),
  };
}

recordsCommand
  .command('list')
  .description('List record tables')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(`/api/${config.projectGuid}/records-config`);

    printList(res.data, opts, 'No tables configured for Records API. Configure one with `gipity records config <table> --auth <level>`.', t =>
      `${bold(t.table_name)}  ${muted(t.auth_level)}  ${muted(`pk=${t.primary_key_column}`)}  ${muted(`db=${t.database_name}`)}`
    );
  }));

recordsCommand
  .command('config <table>')
  .description('Show or set a table\'s Records API config (auth level, search, etc.)')
  .option('--auth <level>', 'Auth level: public (anonymous writes), member (sign-in), or user')
  .option('--searchable <bool>', 'Enable full-text search (true/false)')
  .option('--primary-key <col>', 'Primary key column (default: id)')
  .option('--soft-delete <col>', 'Soft-delete column (pass "none" to clear)')
  .option('--json', 'Output as JSON')
  .action((table: string, opts) => run('Config', async () => {
    const config = requireConfig();
    const base = `/api/${config.projectGuid}/records/${table}/config`;

    // No setter flags → just show the current config.
    const setting = opts.auth || opts.searchable !== undefined || opts.primaryKey || opts.softDelete;
    if (!setting) {
      const res = await get<{ data: any }>(base);
      printResult(JSON.stringify(res.data, null, 2), opts, res.data);
      return;
    }

    const body: Record<string, unknown> = {};
    if (opts.auth) body.auth_level = opts.auth;
    if (opts.searchable !== undefined) body.searchable = /^(true|1|on|yes)$/i.test(String(opts.searchable));
    if (opts.primaryKey) body.primary_key_column = opts.primaryKey;
    if (opts.softDelete) body.soft_delete_column = opts.softDelete === 'none' ? null : opts.softDelete;

    const res = await patch<{ data: any }>(base, body);
    printResult(
      `Configured "${table}": auth=${res.data.auth_level}, searchable=${res.data.searchable}, pk=${res.data.primary_key_column}`,
      opts, res.data,
    );
  }));

recordsCommand
  .command('query <table>')
  .description('List records (full-text search, filter, sort, recycle bin)')
  .option('-q, --q <text>', 'Full-text search across the table\'s text columns (needs `--searchable true` on the table)')
  .option('--filter <filter>', 'AND filter string (e.g., "status:eq:active")')
  .option('--any <filter>', 'OR filter group, same grammar as --filter (e.g., "owner:eq:me,shared:eq:true")')
  .option('--sort <sort>', 'Sort string (e.g., "created_at:desc")')
  .option('--limit <n>', 'Max rows', '20')
  .option('--offset <n>', 'Offset', '0')
  .option('--fields <fields>', 'Comma-separated column names')
  .option('--include-deleted', 'Include soft-deleted rows (owner/editor)')
  .option('--only-deleted', 'Only soft-deleted rows - the recycle bin (owner/editor)')
  .option(ANON_FLAG, ANON_HELP)
  .option('--json', 'Output as JSON')
  .action((table: string, opts) => run('Query', async () => {
    const api = await recordsHttp(opts);
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.filter) params.set('filter', opts.filter);
    if (opts.any) params.set('any', opts.any);
    if (opts.sort) params.set('sort', opts.sort);
    params.set('limit', opts.limit);
    params.set('offset', opts.offset);
    if (opts.fields) params.set('fields', opts.fields);
    if (opts.includeDeleted) params.set('include_deleted', '1');
    if (opts.onlyDeleted) params.set('only_deleted', '1');

    const res = await api.get<{ data: any[]; meta: { total: number } }>(
      `/api/${api.guid}/records/${table}?${params}`,
    );

    if (opts.json) {
      console.log(JSON.stringify(res));
    } else {
      console.log('');
      console.log(`${res.meta.total} total records`);
      for (const row of res.data) {
        console.log(JSON.stringify(row));
      }
      console.log('');
    }
  }));

recordsCommand
  .command('get <table> <id>')
  .description('Get a record')
  .option(ANON_FLAG, ANON_HELP)
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Get', async () => {
    const api = await recordsHttp(opts);
    const res = await api.get<{ data: any }>(`/api/${api.guid}/records/${table}/${id}`);
    console.log(opts.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
  }));

recordsCommand
  .command('history <table> [id]')
  .description('Audit history (who/what changed it, with English summaries). Omit <id> for the whole table\'s feed.')
  .option('--limit <n>', 'Max events', '20')
  .option(ANON_FLAG, ANON_HELP)
  .option('--json', 'Output as JSON')
  .action((table: string, id: string | undefined, opts) => run('History', async () => {
    const api = await recordsHttp(opts);
    // Table-wide feed when no id is given - the same endpoint an activity/history
    // view reads, so verifying it needs no hand-built HTTP call.
    const scope = id ? `${table}/${encodeURIComponent(id)}` : table;
    const res = await api.get<{ data: any[] }>(
      `/api/${api.guid}/records/${scope}/history?limit=${encodeURIComponent(opts.limit)}`,
    );

    printList(res.data, opts, id ? 'No history for this record.' : `No history for "${table}".`, e => {
      const summary = e.detail?.summary || `${e.action} ${e.entity_type} ${e.entity_id}`;
      return `${muted(e.created_at)}  ${bold(e.source || '-')}  ${summary}`;
    });
  }));

recordsCommand
  .command('create <table>')
  .description('Create a record')
  .requiredOption('--data <json>', 'JSON object with field values')
  .option(ANON_FLAG, ANON_HELP)
  .option('--json', 'Output as JSON')
  .action((table: string, opts) => run('Create', async () => {
    const api = await recordsHttp(opts);
    const data = JSON.parse(opts.data);
    const res = await api.post<{ data: any }>(`/api/${api.guid}/records/${table}`, data);
    printResult(`Created: ${JSON.stringify(res.data)}`, opts, res.data);
  }));

recordsCommand
  .command('update <table> <id>')
  .description('Update a record')
  .requiredOption('--data <json>', 'JSON object with fields to update')
  .option(ANON_FLAG, ANON_HELP)
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Update', async () => {
    const api = await recordsHttp(opts);
    const data = JSON.parse(opts.data);
    const res = await api.put<{ data: any }>(`/api/${api.guid}/records/${table}/${id}`, data);
    printResult(`Updated: ${JSON.stringify(res.data)}`, opts, res.data);
  }));

// A table that declares `soft_delete_column` only STAMPS the row on delete - it
// stays queryable via `query --only-deleted` and keeps its audit history. That's
// right for user data and wrong for a probe row you just minted to test the
// wiring, so `--purge` (the server's ?purge=1) is the one call that really
// removes it. The plain success line says which of the two happened and names
// the escape hatch, so nobody has to go spelunking through gipity.js to find it.
recordsCommand
  .command('delete <table> <id>')
  .description('Delete a record (soft-delete when the table declares one; --purge removes it for good)')
  .option('--purge', 'Hard-delete: remove the row AND erase its audit history (owner/editor). Use it to scrub probe rows.')
  .option(ANON_FLAG, ANON_HELP)
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Delete', async () => {
    const what = opts.purge ? `Purge record ${id} from "${table}" (also erases its history)?` : `Delete record ${id} from "${table}"?`;
    if (!await confirm(what)) {
      printResult('Cancelled.', opts, { table, id, deleted: false, cancelled: true });
      return;
    }
    const api = await recordsHttp(opts);
    const res = await api.del<{ data?: any }>(
      `/api/${api.guid}/records/${table}/${id}${opts.purge ? '?purge=1' : ''}`,
    );
    const data = res?.data ?? { table, id, deleted: true, purged: !!opts.purge };
    printResult(
      data.purged
        ? 'Purged - the row and its audit history are gone.'
        : `Deleted. If "${table}" declares a soft-delete column the row is only stamped deleted (see it with \`gipity records query ${table} --only-deleted\`, bring it back with \`gipity records restore ${table} ${id}\`, remove it for good with \`--purge\`).`,
      opts, data,
    );
  }));

recordsCommand
  .command('restore <table> <id>')
  .description('Un-delete a soft-deleted record (owner/editor)')
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Restore', async () => {
    const api = await recordsHttp(opts);
    const res = await api.post<{ data?: any }>(`/api/${api.guid}/records/${table}/${id}/restore`);
    printResult('Restored.', opts, res?.data ?? { table, id, restored: true });
  }));

import { Command } from 'commander';
import { get, post, put, patch, del } from '../api.js';
import { requireConfig } from '../config.js';
import { bold, muted } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';
import { confirm } from '../utils.js';

// All commands hit the app API (https://a.gipity.ai/api/<guid>/records/...),
// which authorizes the logged-in owner via their Bearer token. (The native
// Records API is the only records surface that exists server-side; there is no
// /projects/<guid>/records mirror.)
export const recordsCommand = new Command('records')
  .description('Manage records');

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
  .description('List records')
  .option('--filter <filter>', 'Filter string (e.g., "status:eq:active")')
  .option('--sort <sort>', 'Sort string (e.g., "created_at:desc")')
  .option('--limit <n>', 'Max rows', '20')
  .option('--offset <n>', 'Offset', '0')
  .option('--fields <fields>', 'Comma-separated column names')
  .option('--json', 'Output as JSON')
  .action((table: string, opts) => run('Query', async () => {
    const config = requireConfig();
    const params = new URLSearchParams();
    if (opts.filter) params.set('filter', opts.filter);
    if (opts.sort) params.set('sort', opts.sort);
    params.set('limit', opts.limit);
    params.set('offset', opts.offset);
    if (opts.fields) params.set('fields', opts.fields);

    const res = await get<{ data: any[]; meta: { total: number } }>(
      `/api/${config.projectGuid}/records/${table}?${params}`,
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
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Get', async () => {
    const config = requireConfig();
    const res = await get<{ data: any }>(`/api/${config.projectGuid}/records/${table}/${id}`);
    console.log(opts.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
  }));

recordsCommand
  .command('create <table>')
  .description('Create a record')
  .requiredOption('--data <json>', 'JSON object with field values')
  .option('--json', 'Output as JSON')
  .action((table: string, opts) => run('Create', async () => {
    const config = requireConfig();
    const data = JSON.parse(opts.data);
    const res = await post<{ data: any }>(`/api/${config.projectGuid}/records/${table}`, data);
    printResult(`Created: ${JSON.stringify(res.data)}`, opts, res.data);
  }));

recordsCommand
  .command('update <table> <id>')
  .description('Update a record')
  .requiredOption('--data <json>', 'JSON object with fields to update')
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Update', async () => {
    const config = requireConfig();
    const data = JSON.parse(opts.data);
    const res = await put<{ data: any }>(`/api/${config.projectGuid}/records/${table}/${id}`, data);
    printResult(`Updated: ${JSON.stringify(res.data)}`, opts, res.data);
  }));

recordsCommand
  .command('delete <table> <id>')
  .description('Delete a record')
  .action((table: string, id: string) => run('Delete', async () => {
    if (!await confirm(`Delete record ${id} from "${table}"?`)) {
      console.log('Cancelled.');
      return;
    }
    const config = requireConfig();
    await del(`/api/${config.projectGuid}/records/${table}/${id}`);
    printResult('Deleted.', { json: false });
  }));

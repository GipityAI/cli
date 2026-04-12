import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { requireConfig } from '../config.js';
import { bold, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';
import { confirm } from '../utils.js';

export const recordsCommand = new Command('records')
  .description('Query and manage Records API');

recordsCommand
  .command('list')
  .description('List configured record tables')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/records-config`);

    printList(res.data, opts, 'No tables configured for Records API.', t =>
      `${bold(t.table_name)}  ${muted(t.auth_level)}  ${muted(`pk=${t.primary_key_column}`)}  ${muted(`db=${t.database_name}`)}`
    );
  }));

recordsCommand
  .command('query <table>')
  .description('List records from a table')
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
      `/projects/${config.projectGuid}/records/${table}?${params}`,
    );

    if (opts.json) {
      console.log(JSON.stringify(res));
    } else {
      console.log(`${res.meta.total} total records`);
      for (const row of res.data) {
        console.log(JSON.stringify(row));
      }
    }
  }));

recordsCommand
  .command('get <table> <id>')
  .description('Get a single record')
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Get', async () => {
    const config = requireConfig();
    const res = await get<{ data: any }>(`/projects/${config.projectGuid}/records/${table}/${id}`);
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
    const res = await post<{ data: any }>(`/projects/${config.projectGuid}/records/${table}`, data);
    console.log(opts.json ? JSON.stringify(res.data) : `Created: ${JSON.stringify(res.data)}`);
  }));

recordsCommand
  .command('update <table> <id>')
  .description('Update a record')
  .requiredOption('--data <json>', 'JSON object with fields to update')
  .option('--json', 'Output as JSON')
  .action((table: string, id: string, opts) => run('Update', async () => {
    const config = requireConfig();
    const data = JSON.parse(opts.data);
    const res = await put<{ data: any }>(`/projects/${config.projectGuid}/records/${table}/${id}`, data);
    console.log(opts.json ? JSON.stringify(res.data) : `Updated: ${JSON.stringify(res.data)}`);
  }));

recordsCommand
  .command('delete <table> <id>')
  .description('Delete a record')
  .action((table: string, id: string) => run('Delete', async () => {
    if (!await confirm(`Delete record ${id} from "${table}"? (y/N) `)) {
      console.log('Cancelled.');
      return;
    }
    const config = requireConfig();
    await del(`/projects/${config.projectGuid}/records/${table}/${id}`);
    console.log('Deleted.');
  }));

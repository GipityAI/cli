import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { requireConfig } from '../config.js';
import { bold, error as clrError, muted } from '../colors.js';

export const recordsCommand = new Command('records')
  .description('Query and manage Records API');

recordsCommand
  .command('list')
  .description('List configured record tables')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/records-config`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else if (res.data.length === 0) {
        console.log('No tables configured for Records API.');
      } else {
        for (const t of res.data) {
          console.log(`${bold(t.table_name)}  ${muted(t.auth_level)}  ${muted(`pk=${t.primary_key_column}`)}  ${muted(`db=${t.database_name}`)}`);
        }
      }
    } catch (err: any) {
      console.error(clrError(`List failed: ${err.message}`));
      process.exit(1);
    }
  });

recordsCommand
  .command('query <table>')
  .description('List records from a table')
  .option('--filter <filter>', 'Filter string (e.g., "status:eq:active")')
  .option('--sort <sort>', 'Sort string (e.g., "created_at:desc")')
  .option('--limit <n>', 'Max rows', '20')
  .option('--offset <n>', 'Offset', '0')
  .option('--fields <fields>', 'Comma-separated column names')
  .option('--json', 'Output as JSON')
  .action(async (table: string, opts) => {
    try {
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
    } catch (err: any) {
      console.error(clrError(`Query failed: ${err.message}`));
      process.exit(1);
    }
  });

recordsCommand
  .command('get <table> <id>')
  .description('Get a single record')
  .option('--json', 'Output as JSON')
  .action(async (table: string, id: string, opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: any }>(`/projects/${config.projectGuid}/records/${table}/${id}`);
      console.log(opts.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
    } catch (err: any) {
      console.error(clrError(`Get failed: ${err.message}`));
      process.exit(1);
    }
  });

recordsCommand
  .command('create <table>')
  .description('Create a record')
  .requiredOption('--data <json>', 'JSON object with field values')
  .option('--json', 'Output as JSON')
  .action(async (table: string, opts) => {
    try {
      const config = requireConfig();
      const data = JSON.parse(opts.data);
      const res = await post<{ data: any }>(`/projects/${config.projectGuid}/records/${table}`, data);
      console.log(opts.json ? JSON.stringify(res.data) : `Created: ${JSON.stringify(res.data)}`);
    } catch (err: any) {
      console.error(clrError(`Create failed: ${err.message}`));
      process.exit(1);
    }
  });

recordsCommand
  .command('update <table> <id>')
  .description('Update a record')
  .requiredOption('--data <json>', 'JSON object with fields to update')
  .option('--json', 'Output as JSON')
  .action(async (table: string, id: string, opts) => {
    try {
      const config = requireConfig();
      const data = JSON.parse(opts.data);
      const res = await put<{ data: any }>(`/projects/${config.projectGuid}/records/${table}/${id}`, data);
      console.log(opts.json ? JSON.stringify(res.data) : `Updated: ${JSON.stringify(res.data)}`);
    } catch (err: any) {
      console.error(clrError(`Update failed: ${err.message}`));
      process.exit(1);
    }
  });

recordsCommand
  .command('delete <table> <id>')
  .description('Delete a record')
  .action(async (table: string, id: string) => {
    try {
      const config = requireConfig();
      await del(`/projects/${config.projectGuid}/records/${table}/${id}`);
      console.log('Deleted.');
    } catch (err: any) {
      console.error(clrError(`Delete failed: ${err.message}`));
      process.exit(1);
    }
  });

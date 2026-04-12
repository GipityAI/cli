import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { requireConfig } from '../config.js';
import { run, printList } from '../helpers/index.js';
import { confirm } from '../utils.js';

export const rbacCommand = new Command('rbac')
  .description('Manage RBAC policies');

rbacCommand
  .command('list')
  .description('List all RBAC policies')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/rbac`);

    printList(res.data, opts, 'No RBAC policies configured.', p => {
      const parts = [`${p.role} can ${p.operation} on ${p.table_name}`];
      if (p.row_condition) parts.push(`WHERE ${p.row_condition}`);
      if (p.allowed_columns?.length) parts.push(`columns: ${p.allowed_columns.join(',')}`);
      if (p.readonly_columns?.length) parts.push(`readonly: ${p.readonly_columns.join(',')}`);
      return parts.join('  |  ');
    });
  }));

rbacCommand
  .command('create <table>')
  .description('Create or update an RBAC policy')
  .requiredOption('--role <role>', 'Role: owner, editor, or viewer')
  .requiredOption('--op <operation>', 'Operation: select, insert, update, or delete')
  .option('--condition <sql>', 'SQL WHERE fragment (use $caller_id placeholder)')
  .option('--allowed-columns <cols>', 'Comma-separated allowed columns (select only)')
  .option('--readonly-columns <cols>', 'Comma-separated readonly columns (insert/update)')
  .option('--json', 'Output as JSON')
  .action((table: string, opts) => run('Create', async () => {
    const config = requireConfig();
    const body: any = {
      table_name: table,
      role: opts.role,
      operation: opts.op,
    };
    if (opts.condition) body.row_condition = opts.condition;
    if (opts.allowedColumns) body.allowed_columns = opts.allowedColumns.split(',').map((s: string) => s.trim());
    if (opts.readonlyColumns) body.readonly_columns = opts.readonlyColumns.split(',').map((s: string) => s.trim());

    const res = await post<{ data: any }>(`/projects/${config.projectGuid}/rbac`, body);
    console.log(opts.json ? JSON.stringify(res.data) : 'Policy created.');
  }));

rbacCommand
  .command('delete <table>')
  .description('Delete an RBAC policy')
  .requiredOption('--role <role>', 'Role')
  .requiredOption('--op <operation>', 'Operation')
  .action((table: string, opts) => run('Delete', async () => {
    if (!await confirm(`Delete RBAC policy for "${table}"? (y/N) `)) {
      console.log('Cancelled.');
      return;
    }
    const config = requireConfig();
    await del(`/projects/${config.projectGuid}/rbac`, {
      table_name: table,
      role: opts.role,
      operation: opts.op,
    });
    console.log('Policy deleted.');
  }));

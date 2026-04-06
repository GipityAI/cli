import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { requireConfig } from '../config.js';

export const rbacCommand = new Command('rbac')
  .description('Manage RBAC policies');

rbacCommand
  .command('list')
  .description('List all RBAC policies')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/rbac`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else if (res.data.length === 0) {
        console.log('No RBAC policies configured.');
      } else {
        for (const p of res.data) {
          const parts = [`${p.role} can ${p.operation} on ${p.table_name}`];
          if (p.row_condition) parts.push(`WHERE ${p.row_condition}`);
          if (p.allowed_columns?.length) parts.push(`columns: ${p.allowed_columns.join(',')}`);
          if (p.readonly_columns?.length) parts.push(`readonly: ${p.readonly_columns.join(',')}`);
          console.log(parts.join('  |  '));
        }
      }
    } catch (err: any) {
      console.error(`List failed: ${err.message}`);
      process.exit(1);
    }
  });

rbacCommand
  .command('create <table>')
  .description('Create or update an RBAC policy')
  .requiredOption('--role <role>', 'Role: owner, editor, or viewer')
  .requiredOption('--op <operation>', 'Operation: select, insert, update, or delete')
  .option('--condition <sql>', 'SQL WHERE fragment (use $caller_id placeholder)')
  .option('--allowed-columns <cols>', 'Comma-separated allowed columns (select only)')
  .option('--readonly-columns <cols>', 'Comma-separated readonly columns (insert/update)')
  .option('--json', 'Output as JSON')
  .action(async (table: string, opts) => {
    try {
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
    } catch (err: any) {
      console.error(`Create failed: ${err.message}`);
      process.exit(1);
    }
  });

rbacCommand
  .command('delete <table>')
  .description('Delete an RBAC policy')
  .requiredOption('--role <role>', 'Role')
  .requiredOption('--op <operation>', 'Operation')
  .action(async (table: string, opts) => {
    try {
      const config = requireConfig();
      await del(`/projects/${config.projectGuid}/rbac`, {
        table_name: table,
        role: opts.role,
        operation: opts.op,
      });
      console.log('Policy deleted.');
    } catch (err: any) {
      console.error(`Delete failed: ${err.message}`);
      process.exit(1);
    }
  });

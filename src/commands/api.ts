import { Command } from 'commander';
import { readFileSync } from 'fs';
import { get, put, del } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, bold, muted } from '../colors.js';

interface ProcedureParam {
  name: string;
  type: 'int' | 'string' | 'float' | 'boolean';
  source?: 'auth:userId';
}

interface Procedure {
  name: string;
  description: string | null;
  method: 'read' | 'write';
  auth_level: string;
  database_name: string;
  sql_text: string;
  params: ProcedureParam[];
}

export const apiCommand = new Command('api')
  .description('Manage API procedures');

apiCommand
  .command('list')
  .description('List API procedures')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: Procedure[] }>(`/projects/${config.projectGuid}/procedures`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No API procedures defined.');
        } else {
          for (const p of res.data) {
            const paramStr = p.params.length > 0
              ? ` (${p.params.map(pr => `${pr.name}:${pr.type}`).join(', ')})`
              : '';
            console.log(`${bold(p.name)}  ${muted(`${p.method}/${p.auth_level}`)}  → ${p.database_name}${paramStr}`);
            if (p.description) console.log(`  ${muted(p.description)}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`List failed: ${err.message}`));
      process.exit(1);
    }
  });

apiCommand
  .command('get <name>')
  .description('Show procedure details')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: Procedure }>(`/projects/${config.projectGuid}/procedures/${encodeURIComponent(name)}`);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
      } else {
        const p = res.data;
        console.log(`Name:      ${p.name}`);
        console.log(`Method:    ${p.method}`);
        console.log(`Auth:      ${p.auth_level}`);
        console.log(`Database:  ${p.database_name}`);
        if (p.description) console.log(`Desc:      ${p.description}`);
        if (p.params.length > 0) {
          console.log(`Params:    ${p.params.map(pr => `${pr.name}:${pr.type}${pr.source ? ` (${pr.source})` : ''}`).join(', ')}`);
        }
        console.log(`SQL:\n${p.sql_text}`);
      }
    } catch (err: any) {
      console.error(clrError(`Get failed: ${err.message}`));
      process.exit(1);
    }
  });

apiCommand
  .command('define <name>')
  .description('Create or update an API procedure')
  .requiredOption('--sql <sql>', 'SQL with $1, $2, ... placeholders (or @filename to read from file)')
  .requiredOption('--database <db>', 'Target database name')
  .option('--method <method>', 'read or write', 'write')
  .option('--auth <level>', 'public, user, or member', 'public')
  .option('--params <params>', 'Param definitions as JSON array: [{"name":"x","type":"string"}]', '[]')
  .option('--description <desc>', 'Procedure description')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const config = requireConfig();

      // Read SQL from file if prefixed with @
      let sql = opts.sql;
      if (sql.startsWith('@')) {
        sql = readFileSync(sql.slice(1), 'utf-8');
      }

      let params: ProcedureParam[];
      try {
        params = JSON.parse(opts.params);
      } catch {
        console.error(clrError('Invalid --params JSON. Example: \'[{"name":"color","type":"string"},{"name":"count","type":"int"}]\''));
        process.exit(1);
      }

      const body = {
        sql,
        database: opts.database,
        method: opts.method,
        auth_level: opts.auth,
        params,
        description: opts.description || null,
      };

      const res = await put<{ data: { name: string; action: string } }>(
        `/projects/${config.projectGuid}/procedures/${encodeURIComponent(name)}`,
        body,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        console.log(`${res.data.action === 'created' ? 'Created' : 'Updated'} procedure "${name}".`);
        console.log(`URL: https://a.gipity.ai/api/${config.projectGuid}/call/${name}`);
      }
    } catch (err: any) {
      console.error(clrError(`Define failed: ${err.message}`));
      process.exit(1);
    }
  });

apiCommand
  .command('delete <name>')
  .description('Delete an API procedure')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const config = requireConfig();
      await del<{ success: boolean }>(`/projects/${config.projectGuid}/procedures/${encodeURIComponent(name)}`);

      if (opts.json) {
        console.log(JSON.stringify({ success: true, name }));
      } else {
        console.log(`Deleted "${name}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Delete failed: ${err.message}`));
      process.exit(1);
    }
  });

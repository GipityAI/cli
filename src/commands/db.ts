import { Command } from 'commander';
import { get, post, sendMessage } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError } from '../colors.js';

interface DatabaseEntry {
  friendlyName: string;
  internalName: string;
  projectGuid: string;
}

export const dbCommand = new Command('db')
  .description('Manage project databases');

dbCommand
  .command('query <sql>')
  .description('Execute SQL on project database')
  .option('--database <name>', 'Database name')
  .option('--json', 'Output as JSON')
  .action(async (sql: string, opts) => {
    try {
      const config = requireConfig();

      // If no database specified, find the first one
      let dbName = opts.database;
      if (!dbName) {
        const listRes = await get<{ data: DatabaseEntry[] }>(`/projects/${config.projectGuid}/databases`);
        if (listRes.data.length === 0) {
          console.error(clrError('No databases found. Create one first: gipity db create <name>'));
          process.exit(1);
        }
        dbName = listRes.data[0].friendlyName;
      }

      const res = await post<{
        data: { rows?: any[]; results?: any[]; affectedRows?: number };
      }>(`/projects/${config.projectGuid}/db/query`, { sql, database: dbName });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.rows !== undefined) {
          if (res.data.rows.length === 0) {
            console.log('(no results)');
          } else {
            // Simple table output
            const columns = Object.keys(res.data.rows[0]);
            console.log(columns.join('\t'));
            for (const row of res.data.rows) {
              console.log(columns.map(c => String(row[c] ?? 'NULL')).join('\t'));
            }
          }
        } else if (res.data.affectedRows !== undefined) {
          console.log(`Affected rows: ${res.data.affectedRows}`);
        } else if (res.data.results) {
          console.log(JSON.stringify(res.data.results, null, 2));
        }
      }
    } catch (err: any) {
      console.error(clrError(`Query failed: ${err.message}`));
      process.exit(1);
    }
  });

dbCommand
  .command('list')
  .description('List project databases')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: DatabaseEntry[] }>(`/projects/${config.projectGuid}/databases`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No databases. Create one: gipity db create <name>');
        } else {
          for (const db of res.data) {
            console.log(db.friendlyName);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`List failed: ${err.message}`));
      process.exit(1);
    }
  });

dbCommand
  .command('create <name>')
  .description('Create a project database')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      // DDL delegates to agent (needs confirmation flow)
      const response = await sendMessage(`Create a new database called "${name}" for this project. Confirm when done, no explanation.`);

      if (opts.json) {
        console.log(JSON.stringify({ response }));
      } else {
        console.log(response);
      }
    } catch (err: any) {
      console.error(clrError(`Create failed: ${err.message}`));
      process.exit(1);
    }
  });

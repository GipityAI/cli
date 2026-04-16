import { Command } from 'commander';
import { get, post, sendMessage } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError } from '../colors.js';
import { run, printList } from '../helpers/index.js';
import { confirm } from '../utils.js';

interface DatabaseEntry {
  friendlyName: string;
  internalName: string;
  projectGuid: string;
}

interface AccountDatabaseEntry {
  friendlyName: string;
  projectGuid: string;
  projectName: string | null;
  projectSlug: string | null;
}

interface AccountDatabasesResponse {
  databases: AccountDatabaseEntry[];
  count: number;
  limit: number;
}

export const dbCommand = new Command('db')
  .description('Manage project databases');

dbCommand
  .command('query <sql>')
  .description('Execute SQL on project database')
  .option('--database <name>', 'Database name')
  .option('--json', 'Output as JSON')
  .action((sql: string, opts) => run('Query', async () => {
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
  }));

dbCommand
  .command('list')
  .description('List project databases')
  .option('--all', 'List databases across all projects')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    if (opts.all) {
      const res = await get<{ data: AccountDatabasesResponse }>('/users/me/databases');
      const { databases, count, limit } = res.data;

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }

      console.log(`Databases: ${count}/${limit}\n`);

      if (databases.length === 0) {
        console.log('No databases.');
        return;
      }

      // Group by project
      const grouped = new Map<string, AccountDatabaseEntry[]>();
      for (const db of databases) {
        const key = db.projectGuid;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(db);
      }

      for (const [projectGuid, dbs] of grouped) {
        const label = dbs[0].projectSlug || dbs[0].projectName || projectGuid;
        console.log(label);
        for (const db of dbs) {
          console.log(`  ${db.friendlyName}`);
        }
        console.log();
      }
    } else {
      const config = requireConfig();
      const res = await get<{ data: DatabaseEntry[] }>(`/projects/${config.projectGuid}/databases`);
      printList(res.data, opts, 'No databases. Create one: gipity db create <name>', db => db.friendlyName);
    }
  }));

dbCommand
  .command('create <name>')
  .description('Create a project database')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Create', async () => {
    // DDL delegates to agent (needs confirmation flow)
    const response = await sendMessage(`Create a new database called "${name}" for this project. Confirm when done, no explanation.`);

    if (opts.json) {
      console.log(JSON.stringify({ response }));
    } else {
      console.log(response);
    }
  }));

dbCommand
  .command('drop <name>')
  .description('Drop a database (use --project to drop from another project)')
  .option('--project <slug>', 'Project slug (required if not in a project directory)')
  .option('--yes', 'Skip confirmation')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Drop', async () => {
    const label = opts.project ? `'${name}' from project '${opts.project}'` : `'${name}'`;
    if (!await confirm(`Drop database ${label}? This cannot be undone.`, { skip: opts.yes })) {
      console.log('Cancelled.');
      return;
    }

    if (opts.project) {
      // Account-level drop: resolve project slug to guid via the account databases list
      const listRes = await get<{ data: AccountDatabasesResponse }>('/users/me/databases');
      const match = listRes.data.databases.find(
        db => db.friendlyName === name && (db.projectSlug === opts.project || db.projectGuid === opts.project),
      );
      if (!match) {
        console.error(clrError(`Database '${name}' not found in project '${opts.project}'.`));
        process.exit(1);
      }

      await post<{ data: { success: boolean } }>('/users/me/databases/drop', {
        projectGuid: match.projectGuid,
        name,
      });
    } else {
      const config = requireConfig();
      await post<{ data: { success: boolean } }>(`/projects/${config.projectGuid}/db/manage`, {
        action: 'drop',
        name,
      });
    }

    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      console.log(`Dropped database '${name}'.`);
    }
  }));

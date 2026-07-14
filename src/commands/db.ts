import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, success } from '../colors.js';
import { run, printList, emitField } from '../helpers/index.js';
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
  .description('Manage databases');

dbCommand
  .command('query <sql>')
  .description('Run SQL')
  .option('--database <name>', 'Database name')
  .option('--field <path>', 'Print only this field of the result (dot path, e.g. rows.0.status)')
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

    if (opts.field) {
      emitField(res.data, opts.field);
    } else if (opts.json) {
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
        // DML with RETURNING carries both rows and a count - the rows are the
        // table above; still name how many rows the statement touched.
        if (res.data.affectedRows !== undefined) {
          console.log(`Affected rows: ${res.data.affectedRows}`);
        }
      } else if (res.data.affectedRows !== undefined) {
        console.log(`Affected rows: ${res.data.affectedRows}`);
      } else if (res.data.results) {
        console.log(JSON.stringify(res.data.results, null, 2));
      } else {
        // Unknown payload shape: print it raw rather than nothing - silence
        // here reads as "the query returned no data", which is a lie.
        console.log(JSON.stringify(res.data, null, 2));
      }
    }
  }));

dbCommand
  .command('list')
  .description('List databases')
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

      console.log(`Databases: ${count}/${limit}`);
      console.log('');

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

      let first = true;
      for (const [projectGuid, dbs] of grouped) {
        if (!first) console.log('');
        first = false;
        const label = dbs[0].projectSlug || dbs[0].projectName || projectGuid;
        console.log(label);
        for (const db of dbs) {
          console.log(`${db.friendlyName}`);
        }
      }
    } else {
      const config = requireConfig();
      const res = await get<{ data: DatabaseEntry[] }>(`/projects/${config.projectGuid}/databases`);
      // This list is project-scoped; the account-wide database cap counts
      // databases across ALL projects. An empty project can still be at the
      // cap, so point at `--all` rather than implying nothing exists.
      printList(res.data, opts, 'No databases in this project. Run `gipity db list --all` to see every database counting toward your account cap, or create one: gipity db create <name>', db => db.friendlyName);
    }
  }));

dbCommand
  .command('create <name>')
  .description('Create a database')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Create', async () => {
    // Direct REST create - same endpoint `db drop` uses. This used to delegate
    // to agent chat, which burned LLM tokens and, after the cost-consent gate
    // landed server-side, could return an empty response having created
    // nothing. Creating a database isn't destructive, so no confirmation.
    const config = requireConfig();
    await post<{ data: { success: boolean } }>(`/projects/${config.projectGuid}/db/manage`, {
      action: 'create',
      name,
    });

    if (opts.json) {
      console.log(JSON.stringify({ success: true, name }));
    } else {
      console.log(success(`Created database '${name}'.`));
    }
  }));

dbCommand
  .command('drop <name>')
  .description('Drop a database')
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
      console.log(success(`Dropped database '${name}'.`));
    }
  }));

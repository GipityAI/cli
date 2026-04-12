import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, bold, muted, success } from '../colors.js';
import { run, printList } from '../helpers/index.js';

export const fnCommand = new Command('fn')
  .description('Manage functions');

fnCommand
  .command('list')
  .description('List functions')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/functions`);

    printList(res.data, opts, 'No functions defined.', f => {
      const line = `${bold(f.name)}  ${muted(`v${f.version}`)}  ${muted(f.auth_level)}  ${muted(`timeout=${f.timeout_ms}ms`)}`;
      return f.description ? `${line}\n  ${muted(f.description)}` : line;
    });
  }));

fnCommand
  .command('logs <name>')
  .description('Show recent execution logs')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Logs', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(
      `/projects/${config.projectGuid}/functions/${name}/logs?limit=${opts.limit}`,
    );

    printList(res.data, opts, 'No execution logs.', log => {
      const dur = log.duration_ms != null ? `${log.duration_ms}ms` : '?';
      const ts = new Date(log.created_at).toLocaleString();
      const statusColor = log.status === 'success' ? success : log.status === 'error' ? clrError : muted;
      const line = `${statusColor(log.status)}  ${dur}  ${muted(log.trigger_type || 'http')}  ${muted(ts)}`;
      return log.error_message ? `${line}\n  ${clrError(`error: ${log.error_message}`)}` : line;
    });
  }));

fnCommand
  .command('call <name> [body]')
  .description('Call a function by name')
  .option('--data <json>', 'JSON request body')
  .option('--json', 'Output as JSON')
  .action((name: string, bodyArg: string | undefined, opts) => run('Call', async () => {
    const config = requireConfig();
    const raw = bodyArg || opts.data || '{}';
    const body = JSON.parse(raw);
    const res = await post<{ data: any }>(
      `/api/${config.projectGuid}/fn/${encodeURIComponent(name)}`,
      body,
    );
    console.log(opts.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
  }));

import { Command } from 'commander';
import { get } from '../api.js';
import { requireConfig } from '../config.js';

interface FnLog {
  id: string;
  status: string;
  duration_ms: number | null;
  trigger_type: string;
  limits_consumed: Record<string, number> | null;
  error: string | null;
  created_at: string;
}

export const logsCommand = new Command('logs')
  .description('View execution logs');

logsCommand
  .command('fn <name>')
  .description('Show function execution logs')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const config = requireConfig();
      const limit = parseInt(opts.limit, 10) || 20;
      const res = await get<{ data: FnLog[] }>(
        `/projects/${config.projectGuid}/functions/${encodeURIComponent(name)}/logs?limit=${limit}`
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }

      if (res.data.length === 0) {
        console.log(`No logs for function "${name}".`);
        return;
      }

      console.log(`Logs for "${name}" (last ${res.data.length}):`);
      for (const log of res.data) {
        const time = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const dur = log.duration_ms !== null ? `${log.duration_ms}ms`.padEnd(8) : ''.padEnd(8);
        const status = log.status.padEnd(8);
        const trigger = log.trigger_type.padEnd(8);
        const err = log.error ? `  "${log.error}"` : '';
        console.log(`  ${time}  ${status} ${dur} ${trigger}${err}`);
      }
    } catch (err: any) {
      console.error(`Logs failed: ${err.message}`);
      process.exit(1);
    }
  });

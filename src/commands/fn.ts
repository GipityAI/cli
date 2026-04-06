import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';

export const fnCommand = new Command('fn')
  .description('Manage sandboxed functions');

fnCommand
  .command('list')
  .description('List functions')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/functions`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else if (res.data.length === 0) {
        console.log('No functions defined.');
      } else {
        for (const f of res.data) {
          console.log(`${f.name}  v${f.version}  ${f.auth_level}  timeout=${f.timeout_ms}ms`);
          if (f.description) console.log(`  ${f.description}`);
        }
      }
    } catch (err: any) {
      console.error(`List failed: ${err.message}`);
      process.exit(1);
    }
  });

fnCommand
  .command('logs <name>')
  .description('Show recent execution logs')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: any[] }>(
        `/projects/${config.projectGuid}/functions/${name}/logs?limit=${opts.limit}`,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else if (res.data.length === 0) {
        console.log('No execution logs.');
      } else {
        for (const log of res.data) {
          const dur = log.duration_ms != null ? `${log.duration_ms}ms` : '?';
          const ts = new Date(log.created_at).toLocaleString();
          console.log(`${log.status}  ${dur}  ${log.trigger_type || 'http'}  ${ts}`);
          if (log.error_message) console.log(`  error: ${log.error_message}`);
        }
      }
    } catch (err: any) {
      console.error(`Logs failed: ${err.message}`);
      process.exit(1);
    }
  });

fnCommand
  .command('call <name>')
  .description('Call a function directly')
  .option('--data <json>', 'JSON request body', '{}')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const config = requireConfig();
      const body = JSON.parse(opts.data);
      // Call via the conversation/chat endpoint (agent-mediated)
      // Direct function calls require an app token, so use the agent
      const res = await post<{ data: any }>(
        `/conversations`,
        {
          agentGuid: config.agentGuid,
          projectGuid: config.projectGuid,
          content: `Call function "${name}" with this payload: ${JSON.stringify(body)}`,
          currentPath: '/',
        },
      );
      console.log(opts.json ? JSON.stringify(res.data) : res.data.content);
    } catch (err: any) {
      console.error(`Call failed: ${err.message}`);
      process.exit(1);
    }
  });

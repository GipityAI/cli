import { Command } from 'commander';
import { get } from '../api.js';
import { requireConfig } from '../config.js';

export const auditCommand = new Command('audit')
  .description('Query audit logs');

auditCommand
  .command('list')
  .description('List recent audit events')
  .option('--type <type>', 'Filter by event type (e.g., record.create)')
  .option('--entity <type>', 'Filter by entity type')
  .option('--action <action>', 'Filter by action (create, update, delete)')
  .option('--since <date>', 'Start date (ISO format)')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const params = new URLSearchParams();
      if (opts.type) params.set('type', opts.type);
      if (opts.entity) params.set('entity_type', opts.entity);
      if (opts.action) params.set('action', opts.action);
      if (opts.since) params.set('since', opts.since);
      params.set('limit', opts.limit);

      const res = await get<{ data: any[] }>(
        `/projects/${config.projectGuid}/audit?${params}`,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else if (res.data.length === 0) {
        console.log('No audit events found.');
      } else {
        for (const e of res.data) {
          const ts = new Date(e.created_at).toLocaleString();
          const entity = e.entity_type ? `${e.entity_type}${e.entity_id ? ':' + e.entity_id : ''}` : '';
          console.log(`${ts}  ${e.event_type}  ${e.action}  ${entity}`);
        }
      }
    } catch (err: any) {
      console.error(`List failed: ${err.message}`);
      process.exit(1);
    }
  });

auditCommand
  .command('count')
  .description('Count audit events')
  .option('--type <type>', 'Filter by event type')
  .option('--entity <type>', 'Filter by entity type')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const params = new URLSearchParams();
      if (opts.type) params.set('type', opts.type);
      if (opts.entity) params.set('entity_type', opts.entity);

      const res = await get<{ data: { count: number } }>(
        `/projects/${config.projectGuid}/audit/count?${params}`,
      );

      console.log(opts.json ? JSON.stringify(res.data) : `${res.data.count} events`);
    } catch (err: any) {
      console.error(`Count failed: ${err.message}`);
      process.exit(1);
    }
  });

import { Command } from 'commander';
import { get, put, del } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, muted } from '../colors.js';

interface MemorySummary {
  topic: string;
  content: string;
  updated_at: string;
}

export const memoryCommand = new Command('memory')
  .description('Read/write agent and project memory');

memoryCommand
  .command('list')
  .description('List memory topics')
  .option('--project', 'List project memory (default is agent memory)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const endpoint = opts.project
        ? `/projects/${config.projectGuid}/memory`
        : `/agents/${config.agentGuid}/memory`;

      const res = await get<{ data: MemorySummary[] }>(endpoint);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No memory topics.');
        } else {
          for (const m of res.data) {
            console.log(`${m.topic}  ${muted(`(${new Date(m.updated_at).toLocaleDateString()})`)}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`List failed: ${err.message}`));
      process.exit(1);
    }
  });

memoryCommand
  .command('read <topic>')
  .description('Read a memory topic')
  .option('--project', 'Read project memory')
  .option('--json', 'Output as JSON')
  .action(async (topic: string, opts) => {
    try {
      const config = requireConfig();
      const endpoint = opts.project
        ? `/projects/${config.projectGuid}/memory`
        : `/agents/${config.agentGuid}/memory`;

      const res = await get<{ data: MemorySummary[] }>(endpoint);
      const match = res.data.find(m => m.topic === topic);

      if (!match) {
        console.error(clrError(`Topic "${topic}" not found.`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(match));
      } else {
        console.log(match.content);
      }
    } catch (err: any) {
      console.error(clrError(`Read failed: ${err.message}`));
      process.exit(1);
    }
  });

memoryCommand
  .command('write <topic> <content>')
  .description('Write a memory topic')
  .option('--project', 'Write to project memory')
  .option('--json', 'Output as JSON')
  .action(async (topic: string, content: string, opts) => {
    try {
      const config = requireConfig();
      const endpoint = opts.project
        ? `/projects/${config.projectGuid}/memory/${encodeURIComponent(topic)}`
        : `/agents/${config.agentGuid}/memory/${encodeURIComponent(topic)}`;

      await put<{ success: boolean }>(endpoint, { content });

      if (opts.json) {
        console.log(JSON.stringify({ success: true, topic }));
      } else {
        console.log(`Wrote "${topic}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Write failed: ${err.message}`));
      process.exit(1);
    }
  });

memoryCommand
  .command('delete <topic>')
  .description('Delete a memory topic')
  .option('--project', 'Delete project memory')
  .option('--json', 'Output as JSON')
  .action(async (topic: string, opts) => {
    try {
      const config = requireConfig();
      const endpoint = opts.project
        ? `/projects/${config.projectGuid}/memory/${encodeURIComponent(topic)}`
        : `/agents/${config.agentGuid}/memory/${encodeURIComponent(topic)}`;

      await del<{ success: boolean }>(endpoint);

      if (opts.json) {
        console.log(JSON.stringify({ success: true, topic }));
      } else {
        console.log(`Deleted "${topic}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Delete failed: ${err.message}`));
      process.exit(1);
    }
  });

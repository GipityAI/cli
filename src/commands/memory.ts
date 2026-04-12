import { Command } from 'commander';
import { get, put, del } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';
import { confirm } from '../utils.js';

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
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const endpoint = opts.project
      ? `/projects/${config.projectGuid}/memory`
      : `/agents/${config.agentGuid}/memory`;

    const res = await get<{ data: MemorySummary[] }>(endpoint);
    printList(res.data, opts, 'No memory topics.', m =>
      `${m.topic}  ${muted(`(${new Date(m.updated_at).toLocaleDateString()})`)}`
    );
  }));

memoryCommand
  .command('read <topic>')
  .description('Read a memory topic')
  .option('--project', 'Read project memory')
  .option('--json', 'Output as JSON')
  .action((topic: string, opts) => run('Read', async () => {
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
  }));

memoryCommand
  .command('write <topic> <content>')
  .description('Write a memory topic')
  .option('--project', 'Write to project memory')
  .option('--json', 'Output as JSON')
  .action((topic: string, content: string, opts) => run('Write', async () => {
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
  }));

memoryCommand
  .command('delete <topic>')
  .description('Delete a memory topic')
  .option('--project', 'Delete project memory')
  .option('--json', 'Output as JSON')
  .action((topic: string, opts) => run('Delete', async () => {
    if (!await confirm(`Delete memory "${topic}"? (y/N) `)) {
      console.log('Cancelled.');
      return;
    }
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
  }));

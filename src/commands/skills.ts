import { Command } from 'commander';
import { get } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, bold, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

interface SkillSummary {
  guid: string;
  name: string;
  description: string;
  scope: string;
}

interface SkillDetail extends SkillSummary {
  content: string;
}

export const skillsCommand = new Command('skills')
  .description('List and read skill documentation (platform docs for building apps)');

skillsCommand
  .command('list')
  .description('List available skills')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);

    printList(res.data, opts, 'No skills available.', s =>
      `${bold(s.name)}  ${muted(s.description)}`
    );
  }));

skillsCommand
  .command('read <name>')
  .description('Read a skill\'s full content by name')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Read', async () => {
    const config = requireConfig();
    const listRes = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);
    const match = listRes.data.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      console.error(clrError(`Skill "${name}" not found. Run: gipity skills list`));
      process.exit(1);
    }

    const res = await get<{ data: SkillDetail }>(`/skills/${match.guid}?agent=${config.agentGuid}`);

    if (opts.json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      console.log(res.data.content);
    }
  }));

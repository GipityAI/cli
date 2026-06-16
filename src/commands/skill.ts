import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { get } from '../api.js';
import { resolveProjectContext, getProjectRoot } from '../config.js';
import { error as clrError, bold, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

/** Many kits ship a README but no skill doc. When `skill read <name>` misses
 *  the server catalog, fall back to an installed kit's README so the canonical
 *  lookup doesn't dead-end. Returns the README text, or null if no such kit. */
function readInstalledKitReadme(name: string): string | null {
  const root = getProjectRoot() ?? process.cwd();
  const kitDir = join(root, 'src', 'packages', name);
  if (!existsSync(join(kitDir, 'package.json'))) return null;
  const readme = join(kitDir, 'README.md');
  return existsSync(readme) ? readFileSync(readme, 'utf-8') : null;
}

interface SkillSummary {
  guid: string;
  name: string;
  description: string;
  scope: string;
}

interface SkillDetail extends SkillSummary {
  content: string;
}

export const skillCommand = new Command('skill')
  .description('Read platform docs');

skillCommand
  .command('list')
  .description('List skills')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const { config } = await resolveProjectContext();
    if (!config.agentGuid) {
      console.error(clrError('No agent configured for this project. Run `gipity init` to refresh.'));
      process.exit(1);
    }
    const res = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);

    const width = res.data.reduce((m, s) => Math.max(m, s.name.length), 0);
    printList(res.data, opts, 'No skills available.', s =>
      `  ${bold(s.name.padEnd(width))}  ${muted(s.description)}`,
      'Read one with `gipity skill read <name>`:'
    );
  }));

skillCommand
  .command('read <name>')
  .description('Read a skill')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Read', async () => {
    const { config } = await resolveProjectContext();
    if (!config.agentGuid) {
      console.error(clrError('No agent configured for this project. Run `gipity init` to refresh.'));
      process.exit(1);
    }
    const listRes = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);
    const match = listRes.data.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      // No catalog skill — but if a kit by this name is installed, its README is
      // the guidance the agent is after. Surface it instead of dead-ending.
      const readme = readInstalledKitReadme(name);
      if (readme) {
        if (opts.json) {
          console.log(JSON.stringify({ name, source: 'kit-readme', content: readme }, null, 2));
        } else {
          console.log(muted(`No skill doc for "${name}"; showing the installed kit's README (src/packages/${name}/README.md):\n`));
          console.log(readme);
        }
        return;
      }
      console.error(clrError(`Skill "${name}" not found. Run: gipity skill list`));
      process.exit(1);
    }

    const res = await get<{ data: SkillDetail }>(`/skills/${match.guid}?agent=${config.agentGuid}`);

    if (opts.json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      console.log(res.data.content);
    }
  }));

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PKG_ROOT } from '../updater/state.js';
import { run } from '../helpers/command.js';
import { bold, brand, muted, warning } from '../colors.js';
import {
  ensureChangelogState,
  fetchChangelog,
  fetchNewer,
  markSeen,
  type ChangelogEntry,
} from '../changelog.js';

/** Without --newer or --since, show this many of the newest entries. */
const DEFAULT_LAST = 10;

function cliVersion(): string {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')).version;
}

/** Markdown code spans read fine in a terminal without the backticks. */
const plain = (s: string) => s.replace(/`([^`]+)`/g, '$1');

export function formatEntries(entries: ChangelogEntry[]): string {
  const blocks = entries.map((e) => {
    const versions = [e.server ? `server ${e.server}` : '', e.cli ? `CLI ${e.cli}` : ''].filter(Boolean);
    const lines = [
      brand(bold(e.title)),
      muted([e.date, ...versions].join(', ')),
      ...e.bullets.map((b) => `- ${plain(b)}`),
    ];
    if (e.breaking.length) {
      lines.push(warning('Breaking:'));
      lines.push(...e.breaking.map((b) => `- ${plain(b)}`));
    }
    if (e.skills.length) {
      lines.push(muted(`Docs: ${e.skills.map((s) => `gipity skill read ${s}`).join(', ')}`));
    }
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

export const changelogCommand = new Command('changelog')
  .description("What's new in Gipity (--newer: since you last looked)")
  .option('--newer', 'Only what shipped since you (or your agent) last looked')
  .option('--since <date|version>', 'What shipped since a date (yyyy-mm-dd, that day included) or after a version (1.1.40, cli:1.1.40, server:9.14.781)')
  .option('--last <n>', `Only the newest n entries (default ${DEFAULT_LAST} without --newer or --since)`)
  .option('--json', 'Output the entries as JSON')
  .addHelpText('after', '\nAgents: run `gipity changelog --newer --json` to pull what changed since your docs into context.\n')
  .action((opts: { newer?: boolean; since?: string; last?: string; json?: boolean }) => run('Changelog', async () => {
    if (opts.newer && opts.since) throw new Error('use --newer or --since, not both');
    let last: number | undefined;
    if (opts.last !== undefined) {
      last = Number(opts.last);
      if (!Number.isInteger(last) || last < 1) throw new Error('--last must be a whole number of 1 or more');
    }

    const current = cliVersion();
    const state = ensureChangelogState(current);
    let entries: ChangelogEntry[];
    if (opts.newer) {
      entries = await fetchNewer(state, current);
      if (last !== undefined) entries = entries.slice(0, last);
    } else {
      entries = await fetchChangelog({ since: opts.since, last: last ?? (opts.since ? undefined : DEFAULT_LAST) });
    }
    markSeen(state, entries);

    if (opts.json) {
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(opts.newer ? 'Nothing new since you last looked.' : 'No changelog entries match.');
      return;
    }
    if (opts.newer) console.log(muted(`${entries.length} update${entries.length === 1 ? '' : 's'} since you last looked`) + '\n');
    console.log(formatEntries(entries));
  }));

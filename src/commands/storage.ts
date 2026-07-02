import { Command } from 'commander';
import { get, patch } from '../api.js';
import { brand, muted } from '../colors.js';
import { run } from '../helpers/index.js';

/**
 * File version-retention policy for the current user. Retention bounds how much
 * file version history Gipity keeps (and bills for) by BOTH age (`days`) and
 * copy count (`count`), whichever prunes first. `maxDays`/`maxCount` are the
 * plan cap - the user can only dial retention DOWN from the cap to store/pay
 * less. `customDays`/`customCount` say whether the user set their own value
 * (vs. defaulting to the cap).
 */
export interface RetentionData {
  days: number;
  count: number;
  maxDays: number;
  maxCount: number;
  customDays: boolean;
  customCount: boolean;
}

/** Parse a CLI flag value as a positive whole number, or throw a friendly error.
 *  The server is the source of truth for the plan-cap bound; this just rejects
 *  the obviously-invalid input locally before spending a round trip. */
function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${flag} must be a positive whole number.`);
  }
  const n = parseInt(raw, 10);
  if (n < 1) throw new Error(`${flag} must be a positive whole number.`);
  return n;
}

function printRetention(d: RetentionData, updated: boolean): void {
  console.log(updated ? 'Version retention updated:' : 'Version retention:');
  console.log(`  ${brand(`${d.days} days`)} / ${brand(`${d.count} copies`)}  ${muted('(whichever prunes first)')}`);
  const daysNote = d.customDays ? 'custom' : 'plan default';
  const countNote = d.customCount ? 'custom' : 'plan default';
  console.log(`  ${muted(`days: ${daysNote}, copies: ${countNote}`)}`);
  console.log(muted(`Plan allows up to ${d.maxDays} days / ${d.maxCount} copies.`));
}

export const storageCommand = new Command('storage')
  .description('Manage file storage settings');

storageCommand
  .command('retention')
  .description('View or adjust your file version-retention policy')
  .option('--days <n>', 'Keep versions for at most N days (1..plan cap)')
  .option('--count <n>', 'Keep at most N copies per file (1..plan cap)')
  .option('--reset', 'Reset both days and copies to the plan default')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Retention', async () => {
    const hasSet = opts.days !== undefined || opts.count !== undefined;
    if (opts.reset && hasSet) {
      throw new Error('Use either --reset or --days/--count, not both.');
    }

    let data: RetentionData;
    if (opts.reset) {
      // null resets a field to the plan default; send both.
      const res = await patch<{ data: RetentionData }>('/users/me/retention', { days: null, count: null });
      data = res.data;
    } else if (hasSet) {
      const body: { days?: number; count?: number } = {};
      if (opts.days !== undefined) body.days = parsePositiveInt(opts.days, '--days');
      if (opts.count !== undefined) body.count = parsePositiveInt(opts.count, '--count');
      const res = await patch<{ data: RetentionData }>('/users/me/retention', body);
      data = res.data;
    } else {
      const res = await get<{ data: RetentionData }>('/users/me/retention');
      data = res.data;
    }

    if (opts.json) {
      console.log(JSON.stringify(data));
      return;
    }
    printRetention(data, opts.reset === true || hasSet);
  }));

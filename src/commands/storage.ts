import { Command } from 'commander';
import { get, patch } from '../api.js';
import { formatBytes } from '../adopt-cwd.js';
import { bold, brand, muted, warning } from '../colors.js';
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

/** One project's share of the account's live (current-version) files. */
export interface ProjectStorage {
  projectShortGuid: string | null;
  projectName: string | null;
  liveBytes: number;
  liveFiles: number;
}

/**
 * Storage usage for the current user. `usedBytes` is the BILLED figure (physical
 * bytes: version history included, deduplicated blobs counted once) and is what
 * `quotaBytes` is enforced against. The `storage` split explains how that number
 * arises; `projects` attributes only LIVE bytes, so it won't sum to `usedBytes`.
 */
export interface StorageUsageData {
  quotaBytes: number;
  usedBytes: number;
  storage: {
    liveBytes: number;
    liveFiles: number;
    physicalBytes: number;
    storedObjects: number;
    versionedBytes: number;
    versionCount: number;
    dedupSavedBytes: number;
    dedupedObjects: number;
  };
  versionRetention: { days: number; count: number; maxDays: number; maxCount: number };
  projects: ProjectStorage[];
}

function row(label: string, value: string, note = ''): void {
  console.log(`  ${label.padEnd(16)} ${value.padStart(10)}${note ? `  ${muted(note)}` : ''}`);
}

function printUsage(d: StorageUsageData): void {
  const over = d.usedBytes > d.quotaBytes;
  const pct = d.quotaBytes > 0 ? Math.round((d.usedBytes / d.quotaBytes) * 100) : 0;
  const headline = `${formatBytes(d.usedBytes)} of ${formatBytes(d.quotaBytes)} used (${pct}%)`;
  console.log(`Storage: ${over ? warning(headline) : brand(headline)}`);
  console.log('');

  const s = d.storage;
  row('Live files', formatBytes(s.liveBytes), `${s.liveFiles.toLocaleString()} files`);
  row('All versions', formatBytes(s.versionedBytes), `${s.versionCount.toLocaleString()} versions`);
  row('Dedup saved', formatBytes(s.dedupSavedBytes), `${s.dedupedObjects.toLocaleString()} shared`);
  row('Billed', formatBytes(s.physicalBytes), 'versions kept, dedup applied');

  if (d.projects.length > 0) {
    console.log('');
    console.log(`${bold('By project')} ${muted('(live files only)')}`);
    for (const p of d.projects) {
      const name = p.projectName ?? '(no project)';
      row(name.length > 16 ? `${name.slice(0, 15)}…` : name,
        formatBytes(p.liveBytes), `${p.liveFiles.toLocaleString()} files`);
    }
  }

  const r = d.versionRetention;
  console.log('');
  console.log(muted(`Version retention: ${r.days} days / ${r.count} copies (plan allows up to ${r.maxDays} / ${r.maxCount}).`));
  if (over) {
    console.log(warning('Over quota. Delete files you no longer need, or keep less history with `gipity storage retention`.'));
  }
}

export const storageCommand = new Command('storage')
  .description('Manage file storage settings');

storageCommand
  .command('usage')
  .description('Show what is using your storage, per project and live vs. version history')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Usage', async () => {
    const res = await get<{ data: StorageUsageData }>('/users/me/storage');
    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }
    printUsage(res.data);
  }));

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

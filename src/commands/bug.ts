import { Command } from 'commander';
import { get, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { bold, muted, success, warning } from '../colors.js';
import { run } from '../helpers/index.js';
import { flushBugQueue, isRetryableFailure, queueBugReport } from '../bug-queue.js';

// Kept in sync with @easyclaw/shared BUG_REPORT_CATEGORIES / _SEVERITIES (the CLI
// package can't import the server's shared package). The server validates
// authoritatively; these are for --help and a friendly client-side check.
const CATEGORIES = ['cli', 'deploy', 'template', 'kit', 'db', 'docs', 'skill', 'service', 'sandbox', 'other'];
const SEVERITIES = ['S1', 'S2', 'S3', 'S4'];
const SEVERITY_HINT = 'S1=blocker, S2=major, S3=minor, S4=friction';

interface BugReportRow {
  report_guid: string;
  category: string;
  severity: string;
  summary: string;
  status: string;
  created_at: string;
}

export const bugCommand = new Command('bug')
  .description('Report Gipity platform bugs / friction in real time')
  .addHelpText(
    'after',
    `\nCapture platform friction the moment you hit it — even one you worked around —` +
    `\nso the team can triage it into a fix.\n` +
    `\nCategories: ${CATEGORIES.join(', ')}` +
    `\nSeverity:   ${SEVERITY_HINT}` +
    `\nNever include PII or user data — describe the platform problem in the abstract.` +
    `\nFiled one by mistake? Withdraw it yourself with \`gipity bug retract <id>\`` +
    `\n(works until a human picks it up) — don't file a second report asking for a close.`,
  );

bugCommand
  .command('report')
  .description('File a bug / friction report about the Gipity platform')
  .requiredOption('--category <cat>', `One of: ${CATEGORIES.join(', ')}`)
  .requiredOption('--severity <sev>', SEVERITY_HINT)
  .requiredOption('--summary <text>', 'One line, 7 words max. No PII/user data.')
  .option('--detail <text>', 'Succinct: what you did, what failed, the workaround. No PII/user data.')
  .option('--project <guid-or-slug>', 'Attribute to a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Bug report', async () => {
    const category = String(opts.category).toLowerCase();
    const severity = /^[1-4]$/.test(opts.severity) ? `S${opts.severity}` : String(opts.severity).toUpperCase();
    if (!CATEGORIES.includes(category)) throw new Error(`--category must be one of: ${CATEGORIES.join(', ')}`);
    if (!SEVERITIES.includes(severity)) throw new Error(`--severity must be one of: ${SEVERITY_HINT}`);
    if (String(opts.summary).trim().split(/\s+/).filter(Boolean).length > 7) {
      throw new Error('--summary must be 7 words or fewer');
    }

    const { config } = await resolveProjectContext({ projectOverride: opts.project });

    // Best-effort: deliver anything stranded by an earlier outage/session-expiry
    // before filing the new one, so a single working connection clears the backlog.
    const delivered = await flushBugQueue().catch(() => 0);
    if (delivered > 0 && !opts.json) {
      console.log(muted(`Delivered ${delivered} previously queued bug report${delivered === 1 ? '' : 's'}.`));
    }

    const payload = { category, severity, summary: opts.summary, detail: opts.detail };
    try {
      const res = await post<{ data: { report_guid: string } }>(
        `/api/${config.projectGuid}/services/bug-report/submit`,
        payload,
      );
      if (opts.json) { console.log(JSON.stringify(res.data)); return; }
      console.log(success(`✓ Bug report filed (${res.data.report_guid}) — queued for triage.`));
    } catch (err: any) {
      // The report itself is the record of "the platform broke" - don't lose it
      // just because the breakage (dead session, no network) also blocks filing it.
      if (!isRetryableFailure(err)) throw err;
      queueBugReport({ projectGuid: config.projectGuid, ...payload });
      if (opts.json) { console.log(JSON.stringify({ queued: true })); return; }
      console.log(warning('Bug report saved locally - no connection or session expired.'));
      console.log(muted('It will be delivered automatically next time you log in or file another report.'));
    }
  }));

bugCommand
  .command('retract <id>')
  .description('Withdraw a bug report you filed (e.g. it was your own mistake)')
  .option('--reason <text>', 'Short note for triage on why you are retracting')
  .option('--project <guid-or-slug>', 'Resolve auth against a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .addHelpText(
    'after',
    `\nOnly works on your own reports, and only while they are still queued` +
    `\n(status new/triaged). Once a report is filed/fixed/dismissed, a human` +
    `\nowns closing it out. Find report ids with \`gipity bug list\`.`,
  )
  .action((id, opts) => run('Bug report', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await post<{ data: { report_guid: string; status: string } }>(
      `/api/${config.projectGuid}/services/bug-report/retract`,
      { report_guid: id, reason: opts.reason },
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    console.log(success(`✓ Bug report ${res.data.report_guid} retracted — it is out of the triage queue.`));
  }));

bugCommand
  .command('list')
  .description('List the bug / friction reports you have filed')
  .option('--project <guid-or-slug>', 'Resolve auth against a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Bug report', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await get<{ data: BugReportRow[] }>(
      `/api/${config.projectGuid}/services/bug-report/list`,
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const rows = res.data;
    if (!rows.length) { console.log(warning('No bug reports filed yet.')); return; }
    console.log(bold(`${rows.length} report${rows.length === 1 ? '' : 's'}`));
    for (const r of rows) {
      console.log(`  ${r.severity}  ${muted(r.category.padEnd(8))} ${r.summary}  ${muted(`[${r.status}]`)}`);
      console.log(muted(`      ${r.report_guid}  ${r.created_at}`));
    }
  }));

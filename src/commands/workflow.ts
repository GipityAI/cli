import { Command, Option } from 'commander';
import { get, post, put, del } from '../api.js';
import { getConfig, requireConfig } from '../config.js';
import { success, error as clrError, muted, bold } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';

// `--json` is declared on the parent `workflow` command (so the bare list
// supports it) and again on every subcommand. Commander attributes a `--json`
// typed AFTER a positional arg to the parent's (global) scope, so a
// subcommand's local `opts.json` is missed and JSON output is silently
// dropped. Read the merged opts so `gipity workflow <sub> … --json` always
// works, wherever the flag lands.
function mergedOpts(cmd: Command): { json?: boolean; all?: boolean } {
  return cmd.optsWithGlobals();
}

// Platform timestamp convention (yyyy-mm-dd_hh-mm-ss): sorts chronologically,
// unambiguous, no locale drift.
function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

interface WorkflowData {
  short_guid: string;
  name: string;
  description: string | null;
  is_active: number;
  trigger_type: string;
  cron_expression: string | null;
  trigger_table: string | null;
  // Present on the single-workflow info response for webhook-trigger workflows:
  // the full external URL (including secret) to POST to. null otherwise.
  webhook_url?: string | null;
  project_name: string | null;
  project_slug: string | null;
  steps?: any[];
}

interface WorkflowListResponse {
  data: WorkflowData[];
  meta: { activeCount: number; activeLimit: number };
}

interface RunData {
  short_guid: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  // workflow_runs tracks input/output tokens separately; there is no single
  // `total_tokens` column (reading it rendered a literal "undefined tokens").
  total_input_tokens: number;
  total_output_tokens: number;
  error_message: string | null;
}

interface StepRunData {
  step_order: number;
  /** The step's name from the workflow definition; null if it was deleted. */
  step_name: string | null;
  status: string;
  output_json: unknown;
  tokens_used: number;
  model_used: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

function runTokens(r: RunData): number {
  return (r.total_input_tokens ?? 0) + (r.total_output_tokens ?? 0);
}

function formatRunLine(r: RunData): string {
  const dur = r.completed_at
    ? `${((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
    : 'running';
  const statusColor = r.status === 'completed' ? success : r.status === 'failed' ? clrError : muted;
  return `${muted(r.short_guid)}  ${statusColor(r.status)}  ${dur}  ${runTokens(r)} tokens  ${muted(fmtTime(r.started_at))}`;
}

type JsonStringInfo = { ok: true; value: unknown } | { ok: false } | null;

/** Classify a step-output value that is a *string* holding JSON: parsed, or
 *  looks-like-JSON-but-doesn't-parse (a truncated / cut-off llm response — the
 *  step reports `completed` and the next step then can't read a field out of
 *  it). `null` means "not a JSON string at all". */
function jsonStringInfo(v: unknown): JsonStringInfo {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(t);
    return typeof parsed === 'object' && parsed !== null ? { ok: true, value: parsed } : null;
  } catch { return { ok: false }; }
}

function labelFor(info: Exclude<JsonStringInfo, null>): string {
  return info.ok ? '(JSON string)' : clrError('(truncated/invalid JSON string)');
}

/** Render one step's output for humans.
 *
 *  Step outputs routinely carry a JSON *string* under a key — an `llm` step's
 *  `result` is the common case. Dumped through a plain JSON.stringify that
 *  arrives as one enormous backslash-escaped line: unreadable, and it hides the
 *  single fact you need most, that the NEXT step sees a string, not an object
 *  (so `{{step.summary}}` resolves to nothing). Label such keys
 *  `"key" (JSON string)` and print the decoded value indented under it, so both
 *  the content and the string-vs-object handoff are obvious at a glance. */
function renderStepOutput(output: unknown): string {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return Object.entries(output as Record<string, unknown>).map(([k, v]) => {
      const info = jsonStringInfo(v);
      if (!info) return `${JSON.stringify(k)}: ${JSON.stringify(v, null, 2)}`;
      const body = info.ok ? JSON.stringify(info.value, null, 2) : JSON.stringify(v);
      return `${JSON.stringify(k)} ${labelFor(info)}: ${body}`;
    }).join('\n');
  }
  const info = jsonStringInfo(output);
  if (info?.ok) return JSON.stringify(info.value, null, 2);
  return JSON.stringify(output, null, 2);
}

/** Print each step's status, tokens, model, error and output. A run line alone
 *  says a run finished, not what it did — without the steps you can't tell a
 *  workflow that wrote a row from one that silently skipped every step. */
function printStepRuns(steps: StepRunData[], emptyNote: string): void {
  if (steps.length === 0) {
    console.log(`  ${muted(emptyNote)}`);
    return;
  }
  for (const s of steps) {
    const statusColor = s.status === 'completed' ? success : s.status === 'failed' ? clrError : muted;
    const model = s.model_used ? `  ${muted(`[${s.model_used}]`)}` : '';
    // Name the step: "2. failed" alone doesn't say which one.
    const name = s.step_name ? `${bold(s.step_name)}  ` : '';
    console.log(`  ${s.step_order}. ${name}${statusColor(s.status)}  ${s.tokens_used ?? 0} tokens${model}`);
    if (s.error_message) console.log(`     ${clrError(s.error_message)}`);
    if (s.output_json !== null && s.output_json !== undefined) {
      console.log(renderStepOutput(s.output_json).split('\n').map(l => `     ${l}`).join('\n'));
    }
  }
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Poll a workflow's runs until the run triggered after `prevGuid` reaches a
 * terminal state, returning it. Throws on timeout so the `run()` wrapper reports
 * it. Two phases: wait for the new run row to appear, then poll it to terminal.
 */
async function waitForRun(wfGuid: string, prevGuid: string | undefined, timeoutSec: number): Promise<RunData & { step_runs: StepRunData[] }> {
  const deadline = Date.now() + timeoutSec * 1000;

  let runGuid: string | undefined;
  while (!runGuid) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutSec}s waiting for the run to start.`);
    const latest = await get<{ data: RunData[] }>(`/workflows/${wfGuid}/runs?limit=1`);
    const g = latest.data[0]?.short_guid;
    if (g && g !== prevGuid) runGuid = g;
    else await sleep(1500);
  }

  while (true) {
    const res = await get<{ data: RunData & { step_runs: StepRunData[] } }>(`/workflows/${wfGuid}/runs/${runGuid}`);
    if (TERMINAL_RUN_STATUSES.has(res.data.status)) return res.data;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutSec}s; run ${runGuid} is still ${res.data.status}. Check: gipity workflow runs ${wfGuid} ${runGuid}`);
    await sleep(2000);
  }
}

async function listWorkflows(opts: { json?: boolean; all?: boolean }): Promise<void> {
  const res = await get<WorkflowListResponse>('/workflows');

  // The endpoint is account-wide. Default to the linked project so the list
  // isn't drowned in every other project's workflows; --all (or running outside
  // a linked project) shows everything.
  const config = getConfig();
  const scoped = !opts.all && config
    ? { ...res, data: res.data.filter(w => w.project_slug === config.projectSlug) }
    : res;

  if (opts.json) {
    console.log(JSON.stringify(scoped));
    return;
  }

  if (scoped.meta) {
    console.log(`Active workflows: ${scoped.meta.activeCount}/${scoped.meta.activeLimit}`);
  }
  if (!opts.all && config) {
    console.log(muted(`Project: ${config.projectSlug} (use --all for every project)`));
  }

  printList(scoped.data, opts, opts.all || !config ? 'No workflows.' : `No workflows in ${config.projectSlug}.`, w => {
    const statusText = w.is_active ? success('on') : clrError('off');
    const cron = w.cron_expression ? `  ${muted(`cron: ${w.cron_expression}`)}` : '';
    const table = w.trigger_table ? `  ${muted(`table: ${w.trigger_table}`)}` : '';
    const proj = w.project_slug ? `  ${muted(`(${w.project_slug})`)}` : '';
    const line = `${bold(w.name)}  [${statusText}]  ${muted(w.trigger_type)}${cron}${table}${proj}`;
    return w.description ? `${line}\n  ${muted(w.description)}` : line;
  });
}

export const workflowCommand = new Command('workflow')
  .description('Manage workflows')
  .option('--json', 'Output as JSON')
  .option('--all', 'List workflows across all projects (default: the linked project only)')
  .action((_opts, cmd) => run('Workflow', () => listWorkflows(mergedOpts(cmd))));

workflowCommand
  .command('list')
  .description('List workflows (linked project by default; --all for every project)')
  .option('--json', 'Output as JSON')
  .option('--all', 'List workflows across all projects')
  .action((_opts, cmd) => run('List', () => listWorkflows(mergedOpts(cmd))));

workflowCommand
  .command('info <name>')
  .description('Show workflow details')
  .option('--json', 'Output as JSON')
  .action((name: string, _opts, cmd) => run('Info', async () => {
    const opts = mergedOpts(cmd);
    const wf = await resolveWorkflow(name);
    const res = await get<{ data: WorkflowData }>(`/workflows/${wf.short_guid}`);
    if (opts.json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      const w = res.data;
      console.log(`Name:    ${w.name}`);
      console.log(`GUID:    ${w.short_guid}`);
      console.log(`Active:  ${w.is_active ? 'yes' : 'no'}`);
      console.log(`Trigger: ${w.trigger_type}${w.cron_expression ? ` (${w.cron_expression})` : ''}${w.trigger_table ? ` (table: ${w.trigger_table})` : ''}`);
      if (w.webhook_url) console.log(`Webhook: ${w.webhook_url}`);
      if (w.description) console.log(`Desc:    ${w.description}`);
      if (w.steps && w.steps.length > 0) {
        console.log(`Steps:`);
        for (const s of w.steps) {
          console.log(`${s.step_order}. ${s.name}${s.model ? ` [${s.model}]` : ''}`);
        }
      }
    }
  }));

workflowCommand
  .command('run <name>')
  .description("Run a workflow: waits for it to finish and prints each step's status and output (--no-wait to fire and forget)")
  .option('--json', 'Output as JSON')
  // Waiting is the default: a bare trigger tells you nothing about what the
  // workflow did, so every caller followed it with a poll-and-drill-in loop.
  // `--no-wait` is the escape hatch for fire-and-forget.
  .option('--no-wait', 'Trigger and return immediately instead of waiting for the run')
  // Waiting is already the default, but `--wait` reads naturally and older
  // docs/muscle memory reach for it — accept it silently rather than erroring.
  .addOption(new Option('--wait', 'Wait for the run (already the default)').hideHelp())
  // LLM steps routinely take a couple of minutes; a 120s default timed out on
  // healthy runs and taught callers to always pass --timeout.
  .option('--timeout <s>', 'Max seconds to wait for the run to finish', '300')
  .action((name: string, _opts, cmd) => run('Run', async () => {
    const opts = mergedOpts(cmd) as { json?: boolean; wait?: boolean; timeout?: string };
    const wf = await resolveWorkflow(name);

    if (!opts.wait) {
      const res = await post<{ data: { message: string; workflow_guid: string } }>(`/workflows/${wf.short_guid}/run`, {});
      printResult(`Triggered "${wf.name}".`, opts, res.data);
      return;
    }

    // The trigger endpoint is fire-and-forget — it returns the workflow guid,
    // not a run guid (the run row is created asynchronously inside the executor).
    // So capture the latest run guid BEFORE triggering, then wait for a newer one
    // to appear and poll it to a terminal state. Avoids matching a concurrent run.
    const before = await get<{ data: RunData[] }>(`/workflows/${wf.short_guid}/runs?limit=1`);
    const prevGuid = before.data[0]?.short_guid;

    await post(`/workflows/${wf.short_guid}/run`, {});

    const r = await waitForRun(wf.short_guid, prevGuid, Number(opts.timeout) || 300);
    if (opts.json) {
      console.log(JSON.stringify(r));
    } else {
      console.log(formatRunLine(r));
      if (r.error_message) console.log(`  ${clrError(r.error_message)}`);
      // The whole point of --wait is to see what the run did. The detail endpoint
      // we just polled already carries the steps, so show them rather than make
      // the caller re-query the database to find out whether anything happened.
      printStepRuns(r.step_runs ?? [], '(no steps recorded)');
    }
    if (r.status !== 'completed') process.exit(1);
  }));

workflowCommand
  .command('runs <name> [runGuid]')
  .description('List recent runs, or pass a run guid (wr_...) to see that run\'s per-step outputs')
  .option('--json', 'Output as JSON')
  .action((name: string, runGuid: string | undefined, _opts, cmd) => run('Runs', async () => {
    const opts = mergedOpts(cmd);
    const wf = await resolveWorkflow(name);

    // Drill into one run: show each step's status, tokens, and output so you
    // can verify what a run actually did (e.g. that a notify step sent).
    if (runGuid) {
      const res = await get<{ data: RunData & { step_runs: StepRunData[] } }>(`/workflows/${wf.short_guid}/runs/${runGuid}`);
      const r = res.data;
      if (opts.json) {
        console.log(JSON.stringify(r));
        return;
      }
      console.log(formatRunLine(r));
      printStepRuns(r.step_runs ?? [], '(no steps recorded)');
      return;
    }

    const res = await get<{ data: RunData[] }>(`/workflows/${wf.short_guid}/runs`);
    printList(res.data, opts, 'No runs.', r => {
      const line = formatRunLine(r);
      // Surface why a run failed inline so you don't have to hit the REST API.
      return r.error_message ? `${line}\n  ${clrError(r.error_message)}` : line;
    });
  }));

workflowCommand
  .command('enable <name>')
  .description('Enable a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, _opts, cmd) => run('Enable', async () => {
    const opts = mergedOpts(cmd);
    const wf = await resolveWorkflow(name);
    const res = await put<{ data: WorkflowData }>(`/workflows/${wf.short_guid}`, { is_active: true });
    if (!res.data?.is_active) {
      console.error(clrError(`Workflow "${wf.name}" is still inactive after enable — not enabled.`));
      process.exit(1);
    }
    printResult(`Enabled "${wf.name}".`, opts, { enabled: wf.name, is_active: true });
  }));

workflowCommand
  .command('disable <name>')
  .description('Disable a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, _opts, cmd) => run('Disable', async () => {
    const opts = mergedOpts(cmd);
    const wf = await resolveWorkflow(name);
    const res = await put<{ data: WorkflowData }>(`/workflows/${wf.short_guid}`, { is_active: false });
    if (res.data?.is_active) {
      console.error(clrError(`Workflow "${wf.name}" is still active after disable — not disabled.`));
      process.exit(1);
    }
    printResult(`Disabled "${wf.name}".`, opts, { disabled: wf.name, is_active: false });
  }));

workflowCommand
  .command('create')
  .description('Create a workflow from a YAML file in the project (e.g. workflows/foo.yaml)')
  .requiredOption('--from <path>', 'Project-relative YAML file path')
  .option('--name <name>', 'Override the name in the YAML')
  .option('--json', 'Output as JSON')
  .action((_opts, cmd) => run('Create', async () => {
    const opts = mergedOpts(cmd) as { from?: string; name?: string; json?: boolean };
    const config = requireConfig();
    const body: Record<string, unknown> = {
      config_yaml_path: opts.from,
      project_guid: config.projectGuid,
    };
    if (opts.name) body.name = opts.name;
    const res = await post<{ data: { short_guid?: string; guid?: string } }>('/workflows', body);
    const guid = res.data.short_guid ?? res.data.guid;
    printResult(`Workflow created (${guid}).`, opts, { created: true, guid });
  }));

workflowCommand
  .command('edit <name>')
  .alias('update')
  .description('Update a workflow from a YAML file')
  .requiredOption('--from <path>', 'Project-relative YAML file path')
  .option('--json', 'Output as JSON')
  .action((name: string, _opts, cmd) => run('Edit', async () => {
    const opts = mergedOpts(cmd) as { from?: string; json?: boolean };
    const config = requireConfig();
    const wf = await resolveWorkflow(name);
    await put(`/workflows/${wf.short_guid}`, {
      config_yaml_path: opts.from,
      project_guid: config.projectGuid,
    });
    printResult(`Updated "${wf.name}" from ${opts.from}.`, opts, { updated: wf.name });
  }));

workflowCommand
  .command('delete <name>')
  .description('Delete a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, _opts, cmd) => run('Delete', async () => {
    const opts = mergedOpts(cmd);
    const wf = await resolveWorkflow(name);
    await del(`/workflows/${wf.short_guid}`);
    // Delete is a soft-delete (is_active → 0). Verify the targeted record
    // actually went inactive rather than trusting the request was accepted.
    const after = await get<{ data: WorkflowData }>(`/workflows/${wf.short_guid}`);
    if (after.data?.is_active) {
      console.error(clrError(`Workflow "${wf.name}" (${wf.short_guid}) is still active — delete had no effect.`));
      process.exit(1);
    }
    printResult(`Deleted "${wf.name}".`, opts, { deleted: wf.name, short_guid: wf.short_guid });
  }));

// Resolve a workflow by name within the linked project (like `gipity fn`), or
// by short_guid anywhere. Uses the single account-wide `/workflows` list (the
// same endpoint the bare `workflow` list hits) so the whole command stays on
// one route tree. Names are unique per active project workflow (DB constraint),
// so we scope by the current project's slug; a short_guid resolves anywhere.
async function resolveWorkflow(name: string): Promise<WorkflowData> {
  const { projectSlug } = requireConfig();
  const res = await get<WorkflowListResponse>('/workflows');
  const all = res.data ?? [];

  // Exact short_guid match wins anywhere — unambiguous override.
  const byGuid = all.find(w => w.short_guid === name);
  if (byGuid) return byGuid;

  const byName = all.filter(w => w.project_slug === projectSlug && w.name === name);
  if (byName.length === 0) {
    console.error(clrError(`Workflow "${name}" not found in this project.`));
    process.exit(1);
  }
  if (byName.length === 1) return byName[0]!;

  // More than one (an active + soft-deleted carrying the same name): prefer the
  // active one; refuse if still ambiguous.
  const active = byName.filter(w => w.is_active);
  if (active.length === 1) return active[0]!;
  console.error(clrError(
    `${byName.length} workflows named "${name}" in this project — pass a short_guid:\n` +
    byName.map(w => `  ${w.short_guid}${w.is_active ? '' : ' (inactive)'}`).join('\n'),
  ));
  process.exit(1);
}

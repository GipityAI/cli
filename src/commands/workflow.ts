import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { requireConfig } from '../config.js';
import { success, error as clrError, muted, bold } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';

interface WorkflowData {
  short_guid: string;
  name: string;
  description: string | null;
  is_active: number;
  trigger_type: string;
  cron_expression: string | null;
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
  total_tokens: number;
  error_message: string | null;
}

async function listWorkflows(opts: { json?: boolean }): Promise<void> {
  const res = await get<WorkflowListResponse>('/workflows');

  if (opts.json) {
    console.log(JSON.stringify(res));
    return;
  }

  if (res.meta) {
    console.log(`Active workflows: ${res.meta.activeCount}/${res.meta.activeLimit}`);
  }

  printList(res.data, opts, 'No workflows.', w => {
    const statusText = w.is_active ? success('on') : clrError('off');
    const cron = w.cron_expression ? `  ${muted(`cron: ${w.cron_expression}`)}` : '';
    const proj = w.project_slug ? `  ${muted(`(${w.project_slug})`)}` : '';
    const line = `${bold(w.name)}  [${statusText}]  ${muted(w.trigger_type)}${cron}${proj}`;
    return w.description ? `${line}\n  ${muted(w.description)}` : line;
  });
}

export const workflowCommand = new Command('workflow')
  .description('Manage workflows')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Workflow', () => listWorkflows(opts)));

workflowCommand
  .command('list')
  .description('List workflows')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', () => listWorkflows(opts)));

workflowCommand
  .command('info <name>')
  .description('Show workflow details')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Info', async () => {
    const wf = await resolveWorkflow(name);
    const res = await get<{ data: WorkflowData }>(`/workflows/${wf.short_guid}`);
    if (opts.json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      const w = res.data;
      console.log(`Name:    ${w.name}`);
      console.log(`GUID:    ${w.short_guid}`);
      console.log(`Active:  ${w.is_active ? 'yes' : 'no'}`);
      console.log(`Trigger: ${w.trigger_type}${w.cron_expression ? ` (${w.cron_expression})` : ''}`);
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
  .description('Trigger a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Run', async () => {
    const wf = await resolveWorkflow(name);
    const res = await post<{ data: { message: string; workflow_guid: string } }>(`/workflows/${wf.short_guid}/run`, {});
    printResult(`Triggered "${wf.name}".`, opts, res.data);
  }));

workflowCommand
  .command('runs <name>')
  .description('List recent runs')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Runs', async () => {
    const wf = await resolveWorkflow(name);
    const res = await get<{ data: RunData[] }>(`/workflows/${wf.short_guid}/runs`);

    printList(res.data, opts, 'No runs.', r => {
      const dur = r.completed_at
        ? `${((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
        : 'running';
      const statusColor = r.status === 'completed' ? success : r.status === 'failed' ? clrError : muted;
      const line = `${muted(r.short_guid)}  ${statusColor(r.status)}  ${dur}  ${r.total_tokens} tokens  ${muted(new Date(r.started_at).toLocaleString())}`;
      // Surface why a run failed inline so you don't have to hit the REST API.
      return r.error_message ? `${line}\n  ${clrError(r.error_message)}` : line;
    });
  }));

workflowCommand
  .command('enable <name>')
  .description('Enable a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Enable', async () => {
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
  .action((name: string, opts) => run('Disable', async () => {
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
  .action((opts) => run('Create', async () => {
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
  .action((name: string, opts) => run('Edit', async () => {
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
  .action((name: string, opts) => run('Delete', async () => {
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

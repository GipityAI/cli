import { Command } from 'commander';
import { get, post, put } from '../api.js';
import { requireConfig } from '../config.js';
import { success, error as clrError, muted, bold } from '../colors.js';
import { run, printList } from '../helpers/index.js';

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
}

export const workflowCommand = new Command('workflow')
  .description('Manage workflows')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Workflow', async () => {
    const res = await get<WorkflowListResponse>('/workflows');

    if (opts.json) {
      console.log(JSON.stringify(res));
      return;
    }

    if (res.meta) {
      console.log(`Active workflows: ${res.meta.activeCount}/${res.meta.activeLimit}\n`);
    }

    printList(res.data, opts, 'No workflows.', w => {
      const statusText = w.is_active ? success('on') : clrError('off');
      const cron = w.cron_expression ? `  ${muted(`cron: ${w.cron_expression}`)}` : '';
      const proj = w.project_slug ? `  ${muted(`(${w.project_slug})`)}` : '';
      const line = `${bold(w.name)}  [${statusText}]  ${muted(w.trigger_type)}${cron}${proj}`;
      return w.description ? `${line}\n  ${muted(w.description)}` : line;
    });
  }));

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
          console.log(`  ${s.step_order}. ${s.name}${s.model ? ` [${s.model}]` : ''}`);
        }
      }
    }
  }));

workflowCommand
  .command('run <name>')
  .description('Manually trigger a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Run', async () => {
    const wf = await resolveWorkflow(name);
    const res = await post<{ data: { message: string; workflow_guid: string } }>(`/workflows/${wf.short_guid}/run`, {});
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(`Triggered "${wf.name}".`);
    }
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
      return `${muted(r.short_guid)}  ${statusColor(r.status)}  ${dur}  ${r.total_tokens} tokens  ${muted(new Date(r.started_at).toLocaleString())}`;
    });
  }));

workflowCommand
  .command('enable <name>')
  .description('Enable a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Enable', async () => {
    const wf = await resolveWorkflow(name);
    await put(`/workflows/${wf.short_guid}`, { is_active: true });
    if (opts.json) {
      console.log(JSON.stringify({ enabled: wf.name }));
    } else {
      console.log(`Enabled "${wf.name}".`);
    }
  }));

workflowCommand
  .command('disable <name>')
  .description('Disable a workflow')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Disable', async () => {
    const wf = await resolveWorkflow(name);
    await put(`/workflows/${wf.short_guid}`, { is_active: false });
    if (opts.json) {
      console.log(JSON.stringify({ disabled: wf.name }));
    } else {
      console.log(`Disabled "${wf.name}".`);
    }
  }));

async function resolveWorkflow(name: string): Promise<WorkflowData> {
  const res = await get<{ data: WorkflowData[] }>('/workflows');
  const match = res.data.find(w => w.name === name || w.short_guid === name);
  if (!match) {
    console.error(clrError(`Workflow "${name}" not found.`));
    process.exit(1);
  }
  return match;
}

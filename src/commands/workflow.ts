import { Command } from 'commander';
import { get, post, put } from '../api.js';
import { requireConfig } from '../config.js';
import { success, error as clrError, muted, bold } from '../colors.js';

interface WorkflowData {
  short_guid: string;
  name: string;
  description: string | null;
  is_active: number;
  trigger_type: string;
  cron_expression: string | null;
  steps?: any[];
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
  .action(async (opts) => {
    try {
      const res = await get<{ data: WorkflowData[] }>('/workflows');
      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No workflows.');
        } else {
          for (const w of res.data) {
            const statusText = w.is_active ? success('on') : clrError('off');
            const cron = w.cron_expression ? `  ${muted(`cron: ${w.cron_expression}`)}` : '';
            console.log(`${bold(w.name)}  [${statusText}]  ${muted(w.trigger_type)}${cron}`);
            if (w.description) console.log(`  ${muted(w.description)}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`Failed: ${err.message}`));
      process.exit(1);
    }
  });

workflowCommand
  .command('info <name>')
  .description('Show workflow details')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
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
    } catch (err: any) {
      console.error(clrError(`Info failed: ${err.message}`));
      process.exit(1);
    }
  });

workflowCommand
  .command('run <name>')
  .description('Manually trigger a workflow')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const wf = await resolveWorkflow(name);
      const res = await post<{ data: { message: string; workflow_guid: string } }>(`/workflows/${wf.short_guid}/run`, {});
      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        console.log(`Triggered "${wf.name}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Run failed: ${err.message}`));
      process.exit(1);
    }
  });

workflowCommand
  .command('runs <name>')
  .description('List recent runs')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const wf = await resolveWorkflow(name);
      const res = await get<{ data: RunData[] }>(`/workflows/${wf.short_guid}/runs`);
      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No runs.');
        } else {
          for (const r of res.data) {
            const dur = r.completed_at
              ? `${((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
              : 'running';
            const statusColor = r.status === 'completed' ? success : r.status === 'failed' ? clrError : muted;
            console.log(`${muted(r.short_guid)}  ${statusColor(r.status)}  ${dur}  ${r.total_tokens} tokens  ${muted(new Date(r.started_at).toLocaleString())}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`Runs failed: ${err.message}`));
      process.exit(1);
    }
  });

workflowCommand
  .command('enable <name>')
  .description('Enable a workflow')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const wf = await resolveWorkflow(name);
      await put(`/workflows/${wf.short_guid}`, { is_active: true });
      if (opts.json) {
        console.log(JSON.stringify({ enabled: wf.name }));
      } else {
        console.log(`Enabled "${wf.name}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Enable failed: ${err.message}`));
      process.exit(1);
    }
  });

workflowCommand
  .command('disable <name>')
  .description('Disable a workflow')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const wf = await resolveWorkflow(name);
      await put(`/workflows/${wf.short_guid}`, { is_active: false });
      if (opts.json) {
        console.log(JSON.stringify({ disabled: wf.name }));
      } else {
        console.log(`Disabled "${wf.name}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Disable failed: ${err.message}`));
      process.exit(1);
    }
  });

async function resolveWorkflow(name: string): Promise<WorkflowData> {
  const res = await get<{ data: WorkflowData[] }>('/workflows');
  const match = res.data.find(w => w.name === name || w.short_guid === name);
  if (!match) {
    console.error(clrError(`Workflow "${name}" not found.`));
    process.exit(1);
  }
  return match;
}

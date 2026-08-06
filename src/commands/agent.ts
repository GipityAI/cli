import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { requireConfig, saveConfig } from '../config.js';
import { error as clrError, success, muted } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';
import { confirm } from '../utils.js';

interface AgentData {
  short_guid: string;
  name: string;
  is_default: number;
  model_preference: string | null;
  temperature: number | null;
  voice_id: string | null;
  voice_provider: string | null;
  created_at: string;
}

export const agentCommand = new Command('agent')
  .description('Manage agents')
  .argument('[name]', 'Switch to agent by name')
  .option('--json', 'Output as JSON')
  .action((name: string | undefined, opts) => run('Agent', async () => {
    if (name) {
      // Switch to agent
      const res = await get<{ data: AgentData[] }>('/agents');
      const match = res.data.find(a => a.name === name || a.short_guid === name);
      if (!match) {
        console.error(clrError(`Agent "${name}" not found.`));
        process.exit(1);
      }
      const config = requireConfig();
      saveConfig({ ...config, agentGuid: match.short_guid, conversationGuid: null });
      printResult(`Switched to ${match.name}.`, opts, { switched: match.name, guid: match.short_guid });
      return;
    }

    // List agents
    const res = await get<{ data: AgentData[] }>('/agents');
    const config = requireConfig();
    printList(res.data, opts, 'No agents.', a => {
      const active = a.short_guid === config.agentGuid ? ' *' : '';
      const def = a.is_default ? ' (default)' : '';
      const model = a.model_preference ? `  [${a.model_preference}]` : '';
      return `${a.name}${active}${def}${model}`;
    });
  }));

interface LlmModelData {
  id: string;
  provider: string;
  displayName: string;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  maxContextTokens: number;
  isDefault?: boolean;
  blurb?: string;
}

agentCommand
  .command('models')
  .description('List the LLM models an agent can use (ids and tier aliases for `agent create --model` and `agent set model`)')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Models', async () => {
    const res = await get<{ data: LlmModelData[]; aliases?: Record<string, string> }>('/agents/models');
    if (opts.json) { console.log(JSON.stringify({ models: res.data, aliases: res.aliases ?? {} })); return; }
    const width = res.data.reduce((m, x) => Math.max(m, x.id.length), 0);
    for (const m of res.data) {
      const notes = [
        m.displayName,
        m.provider,
        `$${m.inputCostPerMTok}/$${m.outputCostPerMTok} per 1M tok`,
        `${Math.round(m.maxContextTokens / 1000)}K ctx`,
      ];
      if (m.blurb) notes.push(m.blurb);
      if (m.isDefault) notes.push('default');
      console.log(`${m.id.padEnd(width)}  ${muted(notes.join(' · '))}`);
    }
    // Tier aliases (older servers don't send them): an id pins that exact
    // model; an alias follows the platform's rotation as new models ship.
    if (res.aliases && Object.keys(res.aliases).length > 0) {
      console.log('');
      console.log('Tier aliases (an agent set to one follows the platform model rotations):');
      const aw = Object.keys(res.aliases).reduce((m, k) => Math.max(m, k.length), 0);
      for (const [alias, id] of Object.entries(res.aliases)) {
        console.log(`${alias.padEnd(aw)}  ${muted(`-> ${id}`)}`);
      }
    }
  }));

agentCommand
  .command('create <name>')
  .description('Create an agent')
  .option('--model <model>', 'Model id (pins that model) or tier alias like gipity-default/opus (follows rotations) - see `gipity agent models`. Default: gipity-default')
  .option('--switch', 'Switch to new agent after creation')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Create', async () => {
    const body: any = { name };
    if (opts.model) body.modelPreference = opts.model;
    const res = await post<{ data: AgentData }>('/agents', body);

    if (opts.switch) {
      const config = requireConfig();
      saveConfig({ ...config, agentGuid: res.data.short_guid, conversationGuid: null });
    }

    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(success(`Created "${res.data.name}" (${res.data.short_guid})`));
      if (opts.switch) console.log('Switched.');
    }
  }));

agentCommand
  .command('set <field> <value>')
  .description('Set a field (model, temp). Model ids + tier aliases: `gipity agent models`')
  .option('--json', 'Output as JSON')
  .action((field: string, value: string, opts) => run('Set', async () => {
    const config = requireConfig();
    const body: any = {};
    if (field === 'model') body.modelPreference = value;
    else if (field === 'temp' || field === 'temperature') body.temperature = parseFloat(value);
    else {
      console.error(clrError(`Unknown field: ${field}. Use: model, temp (for soul/goal use \`gipity agent soul|goal\`)`));
      process.exit(1);
    }

    await put(`/agents/${config.agentGuid}`, body);
    printResult(`Set ${field} = ${value}`, opts, { success: true, field, value });
  }));

/** The active agent's guid, or a clear error - the brain commands all need one. */
function requireAgentGuid(): string {
  const config = requireConfig();
  if (!config.agentGuid) {
    console.error(clrError('No active agent. Switch to one with: gipity agent <name>'));
    process.exit(1);
  }
  return config.agentGuid;
}

// --- Brain: soul / goal / rules / learn ---
// These hit the account-scoped /account/agents surface (the same dual-auth,
// app-callable routes a deployed app uses), so the CLI, the web terminal, and an
// app all drive the agent's brain through one set of endpoints. No more
// hand-rolled `curl -X PUT a.gipity.ai/agents/:guid/soul` with a scraped token.

agentCommand
  .command('soul [text...]')
  .description("Show the current agent's soul, or set it (its voice/personality)")
  .option('--json', 'Output as JSON')
  .action((text: string[] | undefined, opts) => run('Soul', async () => {
    const guid = requireAgentGuid();
    if (text && text.length) {
      const content = text.join(' ');
      const res = await put<{ data: { content: string } }>(`/account/agents/${guid}/soul`, { content });
      printResult('Soul updated.', opts, res.data);
    } else {
      const res = await get<{ data: { content: string } }>(`/account/agents/${guid}/soul`);
      printResult(res.data.content || '(no soul set)', opts, res.data);
    }
  }));

agentCommand
  .command('goal [text...]')
  .description("Show the current agent's goal, or set it")
  .option('--clear', 'Clear the goal (back to a plain assistant)')
  .option('--json', 'Output as JSON')
  .action((text: string[] | undefined, opts) => run('Goal', async () => {
    const guid = requireAgentGuid();
    if (opts.clear) {
      const res = await put<{ data: { goal: string | null } }>(`/account/agents/${guid}/goal`, { goal: null });
      printResult('Goal cleared.', opts, res.data);
    } else if (text && text.length) {
      const goal = text.join(' ');
      const res = await put<{ data: { goal: string | null } }>(`/account/agents/${guid}/goal`, { goal });
      printResult('Goal updated.', opts, res.data);
    } else {
      const res = await get<{ data: { goal: string | null } }>(`/account/agents/${guid}/goal`);
      printResult(res.data.goal || '(no goal set)', opts, res.data);
    }
  }));

interface RuleData { short_guid: string; text: string; source: 'manual' | 'learned'; active: boolean; }

const rulesCommand = agentCommand
  .command('rules')
  .description("Show the agent's rules playbook (manual + learned)")
  .option('--json', 'Output as JSON')
  .action((opts) => run('Rules', async () => {
    const guid = requireAgentGuid();
    const res = await get<{ data: RuleData[] }>(`/account/agents/${guid}/rules`);
    printList(res.data, opts, 'No rules yet.', r =>
      `[${r.source}]  ${r.short_guid}  ${r.text}`);
  }));

rulesCommand
  .command('add <text...>')
  .description('Add a manual rule')
  .option('--json', 'Output as JSON')
  .action((text: string[], opts) => run('Add', async () => {
    const guid = requireAgentGuid();
    const res = await post<{ data: RuleData[] }>(`/account/agents/${guid}/rules`, { text: text.join(' ') });
    printResult(`Added rule ${res.data[0].short_guid}.`, opts, res.data[0]);
  }));

rulesCommand
  .command('rm <rule-guid>')
  .alias('delete')
  .description('Deactivate a rule by its guid')
  .option('--json', 'Output as JSON')
  .action((ruleGuid: string, opts) => run('Remove', async () => {
    const guid = requireAgentGuid();
    await del(`/account/agents/${guid}/rules/${ruleGuid}`);
    printResult(`Removed rule ${ruleGuid}.`, opts, { removed: ruleGuid });
  }));

agentCommand
  .command('learn')
  .description("Teach the agent from one correction (distills a durable learned rule)")
  .requiredOption('--original <text>', 'What the agent originally produced')
  .requiredOption('--comment <text>', "Your correction / why it was wrong")
  .option('--json', 'Output as JSON')
  .action((opts) => run('Learn', async () => {
    const guid = requireAgentGuid();
    const res = await post<{ data: { saved: boolean; rule: RuleData | null; reason: string } }>(
      `/account/agents/${guid}/learn`,
      { original: opts.original, comment: opts.comment },
    );
    const d = res.data;
    printResult(
      d.saved ? `Learned: ${d.rule!.text}` : `No rule saved (${d.reason || 'too idiosyncratic to generalize'}).`,
      opts, d,
    );
  }));

agentCommand
  .command('rename <new-name>')
  .description('Rename the current agent')
  .option('--json', 'Output as JSON')
  .action((newName: string, opts) => run('Rename', async () => {
    const config = requireConfig();
    await put(`/agents/${config.agentGuid}`, { name: newName });
    printResult(`Renamed agent to "${newName}".`, opts, { success: true, name: newName });
  }));

agentCommand
  .command('info')
  .description('Show current agent')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Info', async () => {
    const config = requireConfig();
    const res = await get<{ data: AgentData }>(`/agents/${config.agentGuid}`);
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      const a = res.data;
      console.log(`Name:    ${a.name}`);
      console.log(`GUID:    ${a.short_guid}`);
      console.log(`Model:   ${a.model_preference || '(default)'}`);
      console.log(`Temp:    ${a.temperature ?? '(default)'}`);
      if (a.voice_provider) console.log(`Voice:   ${a.voice_provider}/${a.voice_id}`);
      console.log(`Created: ${new Date(a.created_at).toLocaleDateString()}`);
    }
  }));

agentCommand
  .command('delete <name>')
  .description('Delete an agent')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Delete', async () => {
    const res = await get<{ data: AgentData[] }>('/agents');
    const match = res.data.find(a => a.name === name || a.short_guid === name);
    if (!match) {
      console.error(clrError(`Agent "${name}" not found.`));
      process.exit(1);
    }
    if (!await confirm(`Delete agent "${match.name}"?`)) {
      console.log('Cancelled.');
      return;
    }
    await del(`/agents/${match.short_guid}`);
    printResult(`Deleted "${match.name}".`, opts, { deleted: match.name });
  }));

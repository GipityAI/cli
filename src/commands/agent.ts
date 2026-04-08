import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { requireConfig, saveConfig } from '../config.js';
import { error as clrError, success, muted, bold } from '../colors.js';

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
  .action(async (name: string | undefined, opts) => {
    try {
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
        if (opts.json) {
          console.log(JSON.stringify({ switched: match.name, guid: match.short_guid }));
        } else {
          console.log(`Switched to ${match.name}`);
        }
        return;
      }

      // List agents
      const res = await get<{ data: AgentData[] }>('/agents');
      const config = requireConfig();
      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No agents.');
        } else {
          for (const a of res.data) {
            const active = a.short_guid === config.agentGuid ? ' *' : '';
            const def = a.is_default ? ' (default)' : '';
            const model = a.model_preference ? `  [${a.model_preference}]` : '';
            console.log(`${a.name}${active}${def}${model}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`Failed: ${err.message}`));
      process.exit(1);
    }
  });

agentCommand
  .command('create <name>')
  .description('Create a new agent')
  .option('--model <model>', 'Model preference')
  .option('--switch', 'Switch to new agent after creation')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
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
        console.log(`Created "${res.data.name}" (${res.data.short_guid})`);
        if (opts.switch) console.log('Switched.');
      }
    } catch (err: any) {
      console.error(clrError(`Create failed: ${err.message}`));
      process.exit(1);
    }
  });

agentCommand
  .command('set <field> <value>')
  .description('Set agent field (model, temp)')
  .option('--json', 'Output as JSON')
  .action(async (field: string, value: string, opts) => {
    try {
      const config = requireConfig();
      const body: any = {};
      if (field === 'model') body.modelPreference = value;
      else if (field === 'temp' || field === 'temperature') body.temperature = parseFloat(value);
      else {
        console.error(clrError(`Unknown field: ${field}. Use: model, temp`));
        process.exit(1);
      }

      await put(`/agents/${config.agentGuid}`, body);
      if (opts.json) {
        console.log(JSON.stringify({ success: true, field, value }));
      } else {
        console.log(`Set ${field} = ${value}`);
      }
    } catch (err: any) {
      console.error(clrError(`Set failed: ${err.message}`));
      process.exit(1);
    }
  });

agentCommand
  .command('info')
  .description('Show current agent details')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
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
    } catch (err: any) {
      console.error(clrError(`Info failed: ${err.message}`));
      process.exit(1);
    }
  });

agentCommand
  .command('delete <name>')
  .description('Delete an agent')
  .option('--json', 'Output as JSON')
  .action(async (name: string, opts) => {
    try {
      const res = await get<{ data: AgentData[] }>('/agents');
      const match = res.data.find(a => a.name === name || a.short_guid === name);
      if (!match) {
        console.error(`Agent "${name}" not found.`);
        process.exit(1);
      }
      await del(`/agents/${match.short_guid}`);
      if (opts.json) {
        console.log(JSON.stringify({ deleted: match.name }));
      } else {
        console.log(`Deleted "${match.name}".`);
      }
    } catch (err: any) {
      console.error(clrError(`Delete failed: ${err.message}`));
      process.exit(1);
    }
  });

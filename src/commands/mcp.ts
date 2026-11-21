import { Command } from 'commander';
import { get } from '../api.js';
import { bold, muted, success, warning } from '../colors.js';
import { run, PROJECT_OPTION, projectGuidFor } from '../helpers/index.js';

/**
 * `gipity mcp` - the app's hosted MCP server: whether it is on for this
 * environment, its URL, the key profile behind it and the tools it serves,
 * and how to connect an AI app to it. The server is turned on by an `mcp:`
 * block in gipity.yaml; see gipity skill read app-agents.
 */

interface McpStatus {
  on: boolean;
  url: string;
  off_reason: string | null;
  name: string | null;
  profile: string | null;
  instructions: string | null;
  tools: Array<{ name: string; description: string | null; read_only: boolean }>;
}

/** A short connector name for `claude mcp add`: lowercase words joined by "-". */
export function connectorName(name: string | null): string {
  const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'app';
}

export const mcpCommand = new Command('mcp')
  .description("Show this app's MCP server: on or off, its URL, tools, and how to connect Claude or ChatGPT")
  .option(...PROJECT_OPTION)
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
Turn it on with a top-level block in gipity.yaml, then deploy:

  key_profiles:
    agent: { functions: [status, list_logs] }
  mcp:
    profile: agent      # the tools are this profile's functions
    name: My App        # optional, shown when people connect

Each environment has its own server: gipity mcp --env dev.
People connect from Claude or ChatGPT with the URL and sign in to your app.
Details: gipity skill read app-agents`)
  .action((opts) => run('MCP', async () => {
    const status = (await get<{ data: McpStatus }>(`/projects/${await projectGuidFor(opts)}/mcp`)).data;
    const connect = {
      claude_code: `claude mcp add --transport http ${connectorName(status.name)} ${status.url}`,
      chat_apps: 'In Claude or ChatGPT, add a custom connector with the URL; each person signs in to the app and approves.',
    };
    if (opts.json) { console.log(JSON.stringify({ ...status, connect })); return; }

    if (!status.on) {
      console.log(warning(`MCP server: off (${status.off_reason ?? 'not set up'})`));
      console.log(muted('Add mcp: { profile: <a key_profiles name> } to gipity.yaml and deploy. See gipity mcp --help.'));
      return;
    }
    console.log(success(`MCP server: on`));
    console.log(`URL      ${bold(status.url)}`);
    console.log(`Name     ${status.name ?? ''}`);
    console.log(`Profile  ${status.profile ?? ''} (${status.tools.length} tool${status.tools.length === 1 ? '' : 's'})`);
    for (const t of status.tools) {
      console.log(`  ${bold(t.name)}${t.read_only ? muted(' (read only)') : ''}${t.description ? `  ${muted(t.description)}` : ''}`);
    }
    if (!status.tools.length) console.log(muted('  No tools: deploy the functions the profile names (or remove their keys: lock).'));
    console.log('');
    console.log('Connect:');
    console.log(`  Claude Code     ${connect.claude_code}`);
    console.log(`  Claude, ChatGPT ${muted('add a custom connector with the URL; each person signs in to the app and approves')}`);
  }));

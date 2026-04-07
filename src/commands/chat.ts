import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig, saveConfig } from '../config.js';
import { syncDown } from '../sync.js';

const FILE_TOOLS = new Set([
  'file_write', 'file_edit', 'file_delete', 'file_copy', 'file_move',
  'file_rename', 'dir_create', 'dir_delete',
]);

export const chatCommand = new Command('chat')
  .description('Send a message to the Gipity agent')
  .argument('<message>', 'Message to send')
  .option('--new', 'Start a new conversation')
  .option('--json', 'Output as JSON')
  .action(async (message: string, opts) => {
    try {
      const config = requireConfig();

      const useExisting = config.conversationGuid && !opts.new;

      const endpoint = useExisting
        ? `/conversations/${config.conversationGuid}/messages`
        : '/conversations';

      const body = useExisting
        ? { content: message, projectGuid: config.projectGuid }
        : { agentGuid: config.agentGuid, content: message, projectGuid: config.projectGuid };

      const res = await post<{
        data: {
          content: string;
          conversationGuid: string;
          messageGuid: string;
          model: string;
          inputTokens: number;
          outputTokens: number;
          costUsd: number;
          toolsUsed?: {
            toolCallId: string;
            toolName: string;
            toolInput: Record<string, unknown>;
            success: boolean;
            outputPreview?: string;
          }[];
        };
      }>(endpoint, body);

      // Save conversation guid for continuity
      if (res.data.conversationGuid !== config.conversationGuid) {
        saveConfig({ ...config, conversationGuid: res.data.conversationGuid });
      }

      // Check if file tools were used — auto sync-down
      const fileToolsUsed = res.data.toolsUsed?.filter(t => FILE_TOOLS.has(t.toolName)) || [];
      let syncSummary = '';

      if (fileToolsUsed.length > 0) {
        const syncResult = await syncDown();
        if (syncResult.pulled > 0) {
          syncSummary = `\nPulled ${syncResult.pulled} file${syncResult.pulled > 1 ? 's' : ''}:\n${syncResult.summary}`;
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          content: res.data.content,
          toolsUsed: res.data.toolsUsed?.map(t => t.toolName) || [],
          model: res.data.model,
          tokens: res.data.inputTokens + res.data.outputTokens,
          cost: res.data.costUsd,
          conversationGuid: res.data.conversationGuid,
          filesSynced: fileToolsUsed.length > 0,
        }));
      } else {
        // Show agent response
        console.log(res.data.content);

        // Show tools used
        if (res.data.toolsUsed && res.data.toolsUsed.length > 0) {
          const toolNames = [...new Set(res.data.toolsUsed.map(t => t.toolName))];
          console.log(`\nTools: ${toolNames.join(', ')}`);
        }

        // Show sync results
        if (syncSummary) {
          console.log(syncSummary);
        }
      }
    } catch (err: any) {
      console.error(`Chat failed: ${err.message}`);
      process.exit(1);
    }
  });

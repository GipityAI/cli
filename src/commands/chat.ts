import { Command } from 'commander';
import { post } from '../api.js';
import { resolveProjectContext, saveConfig } from '../config.js';
import { syncDown } from '../sync.js';
import { error as clrError, muted } from '../colors.js';

export const chatCommand = new Command('chat')
  .description('Send a message to the Gipity agent')
  .argument('<message>', 'Message to send')
  .option('--new', 'Start a new conversation')
  .option('--json', 'Output as JSON')
  .action(async (message: string, opts) => {
    try {
      const { config } = await resolveProjectContext();

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
          filesChanged?: boolean;
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

      // Auto sync-down when server reports file changes
      let syncSummary = '';
      let syncChanges: { path: string; type: string; size?: number }[] = [];

      if (res.data.filesChanged) {
        const syncResult = await syncDown();
        if (syncResult.pulled > 0) {
          syncSummary = `\nPulled ${syncResult.pulled} file${syncResult.pulled > 1 ? 's' : ''}:\n${syncResult.summary}`;
        }
        syncChanges = syncResult.changes.map(c => ({
          path: c.path,
          type: c.type,
          ...(c.remoteSize != null ? { size: c.remoteSize } : {}),
        }));
      }

      if (opts.json) {
        console.log(JSON.stringify({
          content: res.data.content,
          toolsUsed: res.data.toolsUsed?.map(t => ({
            tool: t.toolName,
            success: t.success,
            output: t.outputPreview || '',
          })) || [],
          model: res.data.model,
          tokens: res.data.inputTokens + res.data.outputTokens,
          cost: res.data.costUsd,
          conversationGuid: res.data.conversationGuid,
          filesSynced: syncChanges.length > 0,
          syncedFiles: syncChanges,
        }));
      } else {
        // Show agent response
        console.log(res.data.content);

        // Show tools used
        if (res.data.toolsUsed && res.data.toolsUsed.length > 0) {
          const toolNames = [...new Set(res.data.toolsUsed.map(t => t.toolName))];
          console.log(`\n${muted('Tools:')} ${toolNames.join(', ')}`);
        }

        // Show sync results
        if (syncSummary) {
          console.log(syncSummary);
        }
      }
    } catch (err: any) {
      console.error(clrError(`Chat failed: ${err.message}`));
      process.exit(1);
    }
  });

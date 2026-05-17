import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { resolveProjectContext, saveConfig } from '../config.js';
import { sync } from '../sync.js';
import { error as clrError, muted } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';

interface ChatSummary {
  short_guid: string;
  title: string | null;
  updated_at: string;
}

export const chatCommand = new Command('chat')
  .description('Send a message to your agent')
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
        const syncResult = await sync({ interactive: false });
        if (syncResult.applied > 0) {
          syncSummary = `\nSynced ${syncResult.applied} change${syncResult.applied > 1 ? 's' : ''}:\n${syncResult.summary}`;
        }
        syncChanges = syncResult.plan.actions.map(a => ({
          path: a.path,
          type: a.kind,
          ...(a.remoteSize != null ? { size: a.remoteSize } : {}),
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

chatCommand
  .command('list')
  .description('List chats')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const res = await get<{ data: ChatSummary[] }>('/conversations');
    printList(res.data, opts, 'No chats.', c => {
      const title = c.title || '(untitled)';
      const updated = c.updated_at ? new Date(c.updated_at).toLocaleDateString() : '';
      return `${c.short_guid}  ${title}  ${muted(updated)}`;
    });
  }));

chatCommand
  .command('rename <guid> <title...>')
  .description('Rename a chat')
  .option('--json', 'Output as JSON')
  .action((guid: string, titleParts: string[], opts) => run('Rename', async () => {
    const title = titleParts.join(' ');
    await put(`/conversations/${guid}`, { title });
    printResult(`Renamed ${guid} → "${title}".`, opts, { guid, title });
  }));

chatCommand
  .command('archive <guid>')
  .description('Archive a chat')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Archive', async () => {
    await put(`/conversations/${guid}`, { archive: true });
    printResult(`Archived ${guid}.`, opts, { guid, archived: true });
  }));

chatCommand
  .command('delete <guid>')
  .description('Delete a chat')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Delete', async () => {
    await del(`/conversations/${guid}`);
    printResult(`Deleted ${guid}.`, opts, { guid, deleted: true });
  }));

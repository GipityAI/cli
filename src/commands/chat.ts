import { Command } from 'commander';
import { get, post, put, del } from '../api.js';
import { resolveProjectContext, requireConfig, saveConfig } from '../config.js';
import { sync } from '../sync.js';
import { error as clrError, muted, success } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';
import { createProgressReporter, withSpinner } from '../progress.js';

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
      const { config, oneOff } = await resolveProjectContext();

      const useExisting = config.conversationGuid && !opts.new;

      const endpoint = useExisting
        ? `/conversations/${config.conversationGuid}/messages`
        : '/conversations';

      const body = useExisting
        ? { content: message, projectGuid: config.projectGuid }
        : { agentGuid: config.agentGuid, content: message, projectGuid: config.projectGuid };

      type ChatResponse = {
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
      };
      // The agent can think for many seconds; animate the wait, then clear the
      // spinner (done:null) so the reply itself is the result. JSON mode skips it.
      const doChat = () => post<ChatResponse>(endpoint, body);
      const res = opts.json
        ? await doChat()
        : await withSpinner('Thinking…', doChat, { done: null });

      // Save conversation guid for continuity. Skipped in one-off mode: the
      // config was resolved from the server's Home project and there is no
      // local `.gipity.json` to update - persisting here would create one in
      // an unrelated directory.
      if (!oneOff && res.data.conversationGuid !== config.conversationGuid) {
        saveConfig({ ...config, conversationGuid: res.data.conversationGuid });
      }

      // Auto sync-down when server reports file changes
      let syncSummary = '';
      let syncChanges: { path: string; type: string; size?: number }[] = [];

      if (res.data.filesChanged) {
        const syncResult = await sync({
          interactive: false,
          progress: opts.json ? undefined : createProgressReporter(),
        });
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
  .command('rename <title...>')
  .description('Rename a chat (the current chat by default; changes the tab title only)')
  .option('--guid <guid>', 'Chat guid to rename (defaults to the current chat)')
  .option('--json', 'Output as JSON')
  .action((titleParts: string[], opts) => run('Rename', async () => {
    const title = titleParts.join(' ');
    const guid = opts.guid || requireConfig().conversationGuid;
    if (!guid) {
      console.error(clrError('No current chat. Start a chat first, or pass --guid <guid>.'));
      process.exit(1);
    }
    await put(`/conversations/${guid}`, { title });
    printResult(success(`Renamed chat → "${title}".`), opts, { guid, title });
  }));

chatCommand
  .command('archive <guid>')
  .description('Archive a chat')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Archive', async () => {
    await put(`/conversations/${guid}`, { archive: true });
    printResult(success(`Archived ${guid}.`), opts, { guid, archived: true });
  }));

chatCommand
  .command('delete <guid>')
  .description('Delete a chat')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Delete', async () => {
    await del(`/conversations/${guid}`);
    printResult(success(`Deleted ${guid}.`), opts, { guid, deleted: true });
  }));

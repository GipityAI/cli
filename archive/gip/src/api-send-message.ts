// ARCHIVED 2026-09-23 with Gip: sendMessage from src/api.ts (the gipity chat send path).

/** Send a message via the conversation API, reusing or creating a conversation. Returns content string. */
export async function sendMessage(message: string): Promise<string> {
  const config = requireConfig();

  const useExisting = !!config.conversationGuid;
  const endpoint = useExisting
    ? `/conversations/${config.conversationGuid}/messages`
    : '/conversations';
  const body = useExisting
    ? { content: message }
    : { agentGuid: config.agentGuid, content: message, projectGuid: config.projectGuid };

  const res = await post<{
    data: {
      content: string;
      conversationGuid: string;
      costWarning?: { message: string; currentModel: string } | null;
    };
  }>(endpoint, body);

  if (res.data.conversationGuid !== config.conversationGuid) {
    saveConfig({ ...config, conversationGuid: res.data.conversationGuid });
  }

  // The server's cost-consent gate stops the agentic loop on big-build
  // requests and returns an explicit costWarning with empty content. Surface
  // it - before this the CLI printed nothing and the command silently did
  // nothing. Replying "y" (next sendMessage) consents and proceeds.
  if (res.data.costWarning && !res.data.content) {
    return res.data.costWarning.message;
  }

  return res.data.content;
}

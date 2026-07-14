/**
 * Claude Code adapter. Encodes today's `gipity claude` behavior exactly -
 * the argv this produces for a relay dispatch must stay byte-identical to
 * the literal the daemon used to build (see relay-daemon tests), because the
 * dispatch path is the hottest relay code and a silent argv drift would
 * break web-CLI `/cc` for everyone.
 */
import type { RemoteAgentAdapter } from './types.js';
import { ensureClaudeInstalled, CLAUDE_PACKAGE } from '../claude-setup.js';

export const claudeCodeAdapter: RemoteAgentAdapter = {
  key: 'claude',
  source: 'claude_code',
  displayName: 'Claude Code',
  providerName: 'Anthropic',
  binary: 'claude',

  buildInteractiveArgs({ resume, model }) {
    const args: string[] = [];
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    return args;
  },

  buildHeadlessArgs({ message, resume, model, bypassApprovals, jsonStream }) {
    const args = ['-p', message];
    if (bypassApprovals) args.push('--permission-mode', 'bypassPermissions');
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    // `--verbose` is required by Claude Code when combining -p with
    // --output-format stream-json; partial messages feed live typing.
    if (jsonStream) args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    return args;
  },

  sessionIdFromStreamEvent(event: any): string | null {
    // Claude's stream-json: the system/init event (and the result footer)
    // carry `session_id`.
    if (event && typeof event.session_id === 'string' && event.session_id) return event.session_id;
    return null;
  },

  hooksSupportedOnPlatform() {
    return true;
  },

  // The daemon parses Claude's stream-json into ingest entries itself
  // (hook capture stands down via GIPITY_CAPTURE=off on dispatches).
  daemonStreamCapture: true,

  ensureInstalled() {
    return ensureClaudeInstalled().installed;
  },
  installHint: `npm install -g ${CLAUDE_PACKAGE}`,
};

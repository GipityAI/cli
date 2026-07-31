/**
 * Grok Build adapter. Flag surface verified against the local `grok --help`
 * (Grok Build TUI, 2026-07-13): `-p/--single` for headless one-shots,
 * `-r/--resume [SESSION_ID]`, `-m/--model`, `--always-approve`, and
 * `--output-format plain|json|streaming-json` (headless only).
 *
 * Grok runs Claude-format plugin hooks natively, so capture rides the same
 * Gipity plugin as Claude Code (capture.cjs rewrites the source to 'grok'
 * under GROK_HOOK_EVENT). Like Codex, relay dispatches keep hook capture ON;
 * the daemon doesn't parse Grok's stream into ingest entries.
 */
import { homedir } from 'os';
import { join } from 'path';
import type { RemoteAgentAdapter } from './types.js';
import { hasEnvPrefix } from './types.js';
import { parseTranscript as parseGrokTranscript } from '../capture/sources/grok.js';
import { grokInstallState, ensureGrokPluginInstalled, removeGrokPlugin } from '../setup.js';

export const grokAdapter: RemoteAgentAdapter = {
  key: 'grok',
  source: 'grok',
  harness: 'grok',
  displayName: 'Grok',
  providerName: 'xAI',
  binary: 'grok',

  buildInteractiveArgs({ resume, model }) {
    const args: string[] = [];
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    return args;
  },

  buildHeadlessArgs({ message, resume, model, bypassApprovals, jsonStream }) {
    const args = ['-p', message];
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    if (bypassApprovals) args.push('--always-approve');
    if (jsonStream) args.push('--output-format', 'streaming-json');
    return args;
  },

  sessionIdFromStreamEvent(event: any): string | null {
    // Grok's streaming-json is ACP-shaped: session/update notifications
    // carry params.sessionId. Accept a top-level sessionId too, defensively.
    const fromParams = event?.params?.sessionId;
    if (typeof fromParams === 'string' && fromParams) return fromParams;
    if (typeof event?.sessionId === 'string' && event.sessionId) return event.sessionId;
    return null;
  },

  hooksSupportedOnPlatform() {
    return true; // in the interactive TUI; headless runs use headlessCapture
  },

  daemonStreamCapture: false,

  // Verified live (2026-07-13): grok -p fires NO plugin hooks - not even
  // SessionStart/Stop - so headless capture is launcher-driven: pin the
  // session id, then replay ~/.grok/sessions/<cwd>/<sid>/chat_history.jsonl
  // through the capture runner after the run.
  headlessCapture: {
    sessionIdArgs: (sessionId) => ['--session-id', sessionId],
  },

  installHint: 'curl -fsSL https://grok.x.ai/install.sh | sh   (or see docs.x.ai/grok-build)',

  detectEnv() {
    if (!hasEnvPrefix('GROK_')) return null;
    return { harness: 'grok', harnessSession: process.env.GROK_SESSION_ID };
  },

  capture: {
    hookKey: 'grok',
    parse: (content, afterUuid, hook) =>
      parseGrokTranscript(content, afterUuid, { sessionId: hook.session_id }),
    // Grok's session dir is derivable: ~/.grok/sessions/<urlencoded-cwd>/<sid>/
    resolveTranscriptPath: (hook) => {
      if (!hook.session_id) return null;
      const cwd = hook.cwd ?? process.cwd();
      return join(homedir(), '.grok', 'sessions', encodeURIComponent(cwd), hook.session_id, 'chat_history.jsonl');
    },
  },

  setup: {
    state: () => grokInstallState(),
    install: ensureGrokPluginInstalled,
    uninstall: () => (removeGrokPlugin() ? 'Gipity plugin removed from Grok.' : null),
  },
};

/**
 * OpenAI Codex adapter. Flag surface verified against Codex CLI v0.144.1
 * (`codex exec --help`, 2026-07-13).
 *
 * Bypass policy: Codex's `--yolo` (--dangerously-bypass-approvals-and-sandbox)
 * disables approvals AND its OS sandbox - broader than Claude's
 * bypassPermissions, which only waives prompts. Relay dispatches use the
 * narrower `-s workspace-write` with network access enabled (the gipity CLI
 * needs the network for sync/deploy), plus `--dangerously-bypass-hook-trust`
 * so our capture/sync hooks fire on relay-materialized project dirs the user
 * never opened `/hooks` in, and `--skip-git-repo-check` because fresh
 * ~/GipityProjects dirs aren't git repos.
 */
import type { RemoteAgentAdapter } from './types.js';

export const codexAdapter: RemoteAgentAdapter = {
  key: 'codex',
  source: 'codex',
  displayName: 'Codex',
  providerName: 'OpenAI',
  binary: 'codex',

  buildInteractiveArgs({ resume, model }) {
    const args: string[] = [];
    if (model) args.push('--model', model);
    if (resume) args.push('resume', resume);
    return args;
  },

  buildHeadlessArgs({ message, resume, model, bypassApprovals, jsonStream }) {
    // `codex exec resume <sid> "<msg>"` continues a session; plain
    // `codex exec "<msg>"` starts fresh. Flags are shared by both forms.
    const args = resume ? ['exec', 'resume', resume, message] : ['exec', message];
    if (model) args.push('--model', model);
    if (bypassApprovals) {
      args.push(
        '-s', 'workspace-write',
        '-c', 'sandbox_workspace_write.network_access=true',
        '--dangerously-bypass-hook-trust',
        '--skip-git-repo-check',
      );
    }
    if (jsonStream) args.push('--json');
    return args;
  },

  sessionIdFromStreamEvent(event: any): string | null {
    // `codex exec --json`: the thread.started event carries thread_id.
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
      return event.thread_id;
    }
    return null;
  },

  hooksSupportedOnPlatform(platform) {
    return platform !== 'win32'; // Codex hooks are disabled on Windows
  },

  // No stream-json ingest mapper for Codex: relay dispatches keep hook
  // capture ON (GIPITY_CONVERSATION_GUID binds it) and the transcript
  // parser mirrors the session; the daemon tracks byte-level progress only.
  daemonStreamCapture: false,

  oneTimeSetupNote:
    'Codex runs project hooks only after a one-time approval: run /hooks inside Codex and approve the Gipity entries, or session recording stays off.',

  installHint: 'npm install -g @openai/codex',
};

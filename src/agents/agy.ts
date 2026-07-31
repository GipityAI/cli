/**
 * Google Antigravity CLI (`agy`) adapter. Flag surface verified live against
 * agy v1.1.2 (2026-07-22): `agy --help`, and a real hook-probe session in a
 * scratch project (see the plan's "Step 0 RESULTS").
 *
 * Two things make agy unlike Claude/Codex/Grok:
 *
 * 1. `--conversation <id>` resumes a *specific, previously-issued* conversation
 *    - unlike Claude's `--continue` (most recent), it never guesses. A plain
 *    launch in a directory agy hasn't seen before also silently mis-binds to
 *    agy's own internal config dir instead of cwd (confirmed live - no error,
 *    just the wrong directory) unless `--new-project` is passed. So every
 *    fresh (non-resume) launch needs `--new-project`, and every resume needs
 *    `--conversation <id>` - there is no bare "just use cwd" third option.
 *
 * 2. `--model` takes agy's own spaced display string (e.g. "Gemini 3.1 Pro
 *    (High)"), not a slug. The web CLI's model-switch route hands adapters a
 *    canonical `LLM_MODELS` id instead (e.g. "gemini-3.1-pro-preview"), so
 *    translateModel() maps the ids we know about and passes anything else
 *    through unchanged - covering both a relay dispatch (canonical id in) and
 *    a human typing agy's native string directly at the CLI (already correct,
 *    nothing to translate). agy itself is the final arbiter of validity.
 *
 * agy fires its own lifecycle hooks (different event names/payload shape than
 * Claude's plugin hooks - see cli/src/hooks/capture-runner.ts) in BOTH
 * interactive and headless `-p` mode, confirmed live, and every hook payload
 * carries `conversationId` directly - so unlike Grok, no `headlessCapture`
 * session-id-pinning/transcript-replay fallback is needed here.
 */
import type { RemoteAgentAdapter } from './types.js';
import { parseTranscript as parseAgyTranscript } from '../capture/sources/agy.js';
import { agySkillsState, ensureAgySkillsInstalled, setupAgyHooks, removeAgySkills } from '../setup.js';

/** LLM_MODELS canonical id -> agy's own spaced --model display string, for the
 *  subset of the Gemini catalog agy actually offers. Anything not listed here
 *  passes through translateModel() unchanged - either it's already agy's own
 *  format (a human typed it directly), or it's a Gemini id agy doesn't have an
 *  equivalent for, in which case agy's own `--model` validation is the right
 *  place to reject it, not a guess made here. */
const MODEL_ID_TO_AGY_DISPLAY: Record<string, string> = {
  'gemini-3.5-flash': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (High)',
};

function translateModel(model: string): string {
  return MODEL_ID_TO_AGY_DISPLAY[model] ?? model;
}

function projectArgs(resume?: string): string[] {
  return resume ? ['--conversation', resume] : ['--new-project'];
}

export const agyAdapter: RemoteAgentAdapter = {
  key: 'agy',
  source: 'agy',
  harness: 'agy',
  displayName: 'Antigravity',
  providerName: 'Google',
  binary: 'agy',

  buildInteractiveArgs({ resume, model }) {
    const args = [...projectArgs(resume)];
    if (model) args.push('--model', translateModel(model));
    return args;
  },

  buildHeadlessArgs({ message, resume, model, bypassApprovals }) {
    const args = ['-p', message, ...projectArgs(resume)];
    if (model) args.push('--model', translateModel(model));
    if (bypassApprovals) args.push('--dangerously-skip-permissions');
    return args;
  },

  sessionIdFromStreamEvent(): string | null {
    // agy has no --json/--output-format flag (confirmed: `agy --help` lists
    // none, and `-p` stdout is plain prose) - there is no stream to read a
    // session id off. Capture relies entirely on hooks (see class comment).
    return null;
  },

  hooksSupportedOnPlatform(platform) {
    return platform !== 'win32'; // agy's hooks.json wiring is POSIX-only, like Codex's
  },

  // No stream-json ingest mapper for agy: hook capture carries the full
  // conversationId on every event (confirmed live, including headless -p),
  // so the daemon doesn't need to parse agy's stdout at all.
  daemonStreamCapture: false,

  installHint: 'see https://antigravity.google (Google account sign-in required)',

  detectEnv() {
    // Antigravity injects ANTIGRAVITY_CONVERSATION_ID into every hook/tool
    // subprocess it spawns (confirmed live). Check this exact var, not an
    // 'ANTIGRAVITY_' prefix scan - the Antigravity IDE's own integrated
    // terminal ambiently sets other ANTIGRAVITY_*-prefixed vars (e.g.
    // ANTIGRAVITY_CLI_ALIAS) in every shell it spawns, which would
    // false-positive for any user with the IDE open, even outside a real
    // agy session/hook.
    if (!process.env.ANTIGRAVITY_CONVERSATION_ID) return null;
    return { harness: 'agy', harnessSession: process.env.ANTIGRAVITY_CONVERSATION_ID };
  },

  capture: {
    hookKey: 'agy',
    // agy hook payloads always carry transcriptPath directly (no derivation
    // needed, unlike Grok) - the agy-specific hook wrapper normalizes it into
    // this HookInput's transcript_path before invoking this runner.
    parse: (content, afterUuid, hook) =>
      parseAgyTranscript(content, afterUuid, { conversationId: hook.session_id }),
  },

  setup: {
    state: () => agySkillsState(),
    install: ensureAgySkillsInstalled,
    writeProjectHooks: setupAgyHooks,
    uninstall: () => {
      const n = removeAgySkills();
      return n ? `Removed ${n} Gipity skills from ~/.gemini/config/skills.` : null;
    },
  },
};

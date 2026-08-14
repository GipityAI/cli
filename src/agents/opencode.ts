/**
 * opencode adapter (opencode.ai, Anomaly - vanilla opencode, never a fork).
 * Flag surface per the opencode 1.18.x CLI docs: `opencode run [message..]`
 * for headless one-shots with `--model provider/model`, `--session <id>` to
 * continue, `--auto` to auto-approve permissions, `--format json`.
 *
 * Models: the Gipity opencode plugin registers a "gipity" provider - the
 * curated open coding models (DeepSeek / Qwen / Kimi / GLM families) billed
 * via the user's Gipity credits through the platform's serving path. A
 * `--model` value with no provider prefix (a Gipity id or family alias like
 * `deepseek`) is therefore namespaced to `gipity/…` here; opencode-native
 * refs (`anthropic/…`, `openrouter/…`) pass through for BYO-key users.
 *
 * Capture: opencode fires no Claude-format hooks, but it loads plugins in
 * every mode (TUI, `run`, serve). The Gipity plugin mirrors sessions itself -
 * on session.idle it writes a normalized transcript to
 * ~/.gipity/opencode/transcripts/<session_id>.jsonl and invokes the capture
 * runner (`capture.cjs opencode stop`), riding the same ingest spine as every
 * other agent. No launcher-driven replay hack needed (that path exists for
 * Grok because grok -p fires nothing; opencode's plugin bus fires everywhere).
 */
import { homedir } from 'os';
import { join } from 'path';
import type { RemoteAgentAdapter } from './types.js';
import { hasEnvPrefix } from './types.js';
import { planForInstall, whichFirst } from './self-update.js';
import { parseTranscript as parseOpencodeTranscript } from '../capture/sources/opencode.js';
import {
  OPENCODE_PACKAGE, ensureOpencodeInstalled, ensureOpencodePluginInstalled,
  ensureOpencodeModelToken, opencodePluginState, removeOpencodePlugin,
} from '../opencode-setup.js';
import { ensureOpencodeSkillsInstalled, removeAgentSkills } from '../setup.js';

/** opencode's own built-in provider namespaces. A --model whose first segment
 *  is one of these is an opencode-native ref (BYO key) and passes through;
 *  anything else is treated as a Gipity model id/alias and namespaced to the
 *  plugin's "gipity" provider. */
const OPENCODE_NATIVE_PROVIDERS = new Set([
  'gipity', 'anthropic', 'openai', 'google', 'openrouter', 'xai', 'groq',
  'mistral', 'azure', 'amazon-bedrock', 'github-copilot', 'opencode',
]);

function toOpencodeModel(model: string): string {
  const head = model.split('/', 1)[0];
  return OPENCODE_NATIVE_PROVIDERS.has(head) ? model : `gipity/${model}`;
}

export const opencodeAdapter: RemoteAgentAdapter = {
  key: 'opencode',
  source: 'opencode',
  harness: 'opencode',
  displayName: 'opencode',
  providerName: 'Anomaly',
  binary: 'opencode',

  buildInteractiveArgs({ resume, model }) {
    const args = ['--dir', process.cwd()];
    if (model) args.push('--model', toOpencodeModel(model));
    if (resume) args.push('--session', resume);
    return args;
  },

  buildHeadlessArgs({ message, resume, model, bypassApprovals, jsonStream }) {
    // `--dir` is REQUIRED, not a nicety: opencode resolves its own working
    // directory rather than inheriting the spawn cwd, and lands on $HOME when
    // nothing tells it otherwise. On a cloud devbox that meant every file the
    // agent wrote went to /home/relay instead of the project - so nothing
    // synced back to Gipity and the user saw an agent that "didn't write any
    // files" (observed live 2026-08-14: `← Write /home/relay/foo.txt` while
    // the daemon's own sync ran in .../GipityProjects/project-394).
    //
    // process.cwd() is the right value: `gipity build` is spawned by the relay
    // daemon with cwd set to the resolved project dir, and launches the agent
    // from that same cwd.
    const args = ['run', '--dir', process.cwd(), message];
    if (model) args.push('--model', toOpencodeModel(model));
    if (resume) args.push('--session', resume);
    if (bypassApprovals) args.push('--auto');
    if (jsonStream) args.push('--format', 'json');
    return args;
  },

  sessionIdFromStreamEvent(event: any): string | null {
    // `opencode run --format json` emits bus events; session ids ride
    // properties.sessionID (message/part events) or properties.info.id
    // (session.created/updated).
    const fromProps = event?.properties?.sessionID;
    if (typeof fromProps === 'string' && fromProps) return fromProps;
    const fromInfo = event?.properties?.info?.id;
    if (typeof fromInfo === 'string' && fromInfo.startsWith('ses')) return fromInfo;
    return null;
  },

  hooksSupportedOnPlatform() {
    return true; // plugin-based capture; no OS-specific hook files
  },

  daemonStreamCapture: false,

  ensureInstalled() {
    return ensureOpencodeInstalled();
  },
  // Plain literal, not `npm install -g ${OPENCODE_PACKAGE}`: this module sits
  // in an import cycle (opencode.ts -> opencode-setup.ts -> setup.ts -> ...
  // -> agents/index.ts -> opencode.ts), so a module-eval read of an imported
  // binding hits the TDZ when the cycle is entered from setup.ts's side.
  // Function bodies (updatePlan below) read the live binding safely.
  installHint: 'npm install -g opencode-ai   (or: curl -fsSL https://opencode.ai/install | bash)',

  updatePlan() {
    // Same-channel rule: npm-global installs update via npm; anything else
    // (the curl installer) gets opencode's own `opencode upgrade`.
    return planForInstall(whichFirst('opencode'), OPENCODE_PACKAGE, ['opencode', 'upgrade']);
  },

  async prepareLaunch() {
    // The model slot needs a long-lived token before opencode starts (the
    // plugin reads it at provider-auth time). Mint/refresh is a no-op when
    // one is already valid.
    await ensureOpencodeModelToken();
  },

  detectEnv() {
    // The Gipity plugin injects OPENCODE_SESSION_ID into every shell opencode
    // spawns (shell.env hook); opencode itself may leak other OPENCODE_* vars.
    if (!hasEnvPrefix('OPENCODE')) return null;
    return { harness: 'opencode', harnessSession: process.env.OPENCODE_SESSION_ID };
  },

  capture: {
    hookKey: 'opencode',
    parse: (content, afterUuid) => parseOpencodeTranscript(content, afterUuid),
    // The plugin writes the transcript at a derivable path, so a hook payload
    // without transcript_path still resolves.
    resolveTranscriptPath: (hook) => {
      if (!hook.session_id) return null;
      const gipityDir = process.env.GIPITY_DIR || join(homedir(), '.gipity');
      return join(gipityDir, 'opencode', 'transcripts', `${hook.session_id}.jsonl`);
    },
  },

  setup: {
    state: () => opencodePluginState(),
    install: () => {
      ensureOpencodeSkillsInstalled();
      ensureOpencodePluginInstalled();
    },
    uninstall: () => {
      const removedPlugin = removeOpencodePlugin();
      const n = removeAgentSkills();
      if (!removedPlugin && !n) return null;
      const parts: string[] = [];
      if (removedPlugin) parts.push('Gipity plugin removed from opencode.');
      if (n) parts.push(`Removed ${n} Gipity skills from ~/.agents/skills.`);
      return parts.join(' ');
    },
  },
};

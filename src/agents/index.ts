/**
 * Agent adapter registry. Two lookups: by CLI key (`--agent claude`) and by
 * server source ('claude_code' on a claimed dispatch). Both throw on unknown
 * values - a typo'd agent must fail loudly, not fall back to Claude.
 */
import type { RemoteAgentAdapter } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';
import { agyAdapter } from './agy.js';

export type { RemoteAgentAdapter, HeadlessArgsOpts, CaptureHookInput, CaptureParseResult } from './types.js';

/** Picker/help order: Claude first (the default), then the others. */
export const AGENT_ADAPTERS: RemoteAgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  grokAdapter,
  agyAdapter,
];

export const AGENT_KEYS = AGENT_ADAPTERS.map(a => a.key);

export function getAdapter(key: string): RemoteAgentAdapter {
  const found = AGENT_ADAPTERS.find(a => a.key === key);
  if (!found) throw new Error(`Unknown agent "${key}". Valid: ${AGENT_KEYS.join(', ')}`);
  return found;
}

export function getAdapterBySource(source: string): RemoteAgentAdapter {
  const found = AGENT_ADAPTERS.find(a => a.source === source);
  if (!found) throw new Error(`No agent adapter for source "${source}"`);
  return found;
}

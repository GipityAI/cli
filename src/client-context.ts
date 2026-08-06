import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AGENT_ADAPTERS } from './agents/index.js';
import { hasEnvPrefix } from './agents/types.js';

/**
 * Best-effort descriptor of what's running the CLI: a human at a terminal vs. an
 * AI coding harness (Claude Code, Codex, …) or CI. Sent on every API request via
 * the `X-Gipity-Client` header so the server can attribute actions (deploys,
 * project creates) to the harness instead of guessing.
 *
 * Derived purely from environment variables the harness leaks into the shell it
 * spawns us in, so it's an analytics signal - not auth, and not a secret. We
 * deliberately do NOT send hostname / OS username (PII with little value); the
 * server already observes the source IP.
 */
export interface ClientContext {
  cli: string;
  harness: 'claude-code' | 'codex' | 'grok' | 'agy' | 'opencode' | 'cursor' | 'aider' | 'gemini' | 'ci' | 'manual';
  harnessVersion?: string;
  harnessSession?: string;
  node?: string;
  os?: string;
  arch?: string;
  ci?: boolean;
}

export function cliVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, '../package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isCi(): boolean {
  const ci = (process.env.CI ?? '').toLowerCase();
  return ci === '1' || ci === 'true' || !!process.env.GITHUB_ACTIONS;
}

/** Identify the coding harness from its env footprint. Order = specificity:
 *  each agent adapter's detectEnv() is tried in registry order (claude,
 *  codex, grok, agy today), then the non-agent harnesses below - tools with
 *  no adapter (no execution surface, no capture) because they're either not
 *  a coding agent (cursor, ci) or not yet integrated (aider, gemini).
 *  Exported for tests. */
export function detectHarness(): Pick<ClientContext, 'harness' | 'harnessVersion' | 'harnessSession'> {
  for (const agent of AGENT_ADAPTERS) {
    const match = agent.detectEnv?.();
    if (match) {
      return {
        harness: match.harness as ClientContext['harness'],
        harnessVersion: match.harnessVersion,
        harnessSession: match.harnessSession,
      };
    }
  }
  if (process.env.CURSOR_TRACE_ID || hasEnvPrefix('CURSOR_') || (process.env.TERM_PROGRAM ?? '').toLowerCase().includes('cursor')) {
    return { harness: 'cursor' };
  }
  if (hasEnvPrefix('AIDER_')) return { harness: 'aider' };
  if (process.env.GEMINI_CLI) return { harness: 'gemini' };
  if (isCi()) return { harness: 'ci' };
  return { harness: 'manual' };
}

let cached: ClientContext | undefined;

export function clientContext(): ClientContext {
  if (cached) return cached;
  cached = {
    cli: cliVersion(),
    ...detectHarness(),
    node: process.versions.node,
    os: process.platform,
    arch: process.arch,
    ci: isCi() || undefined,
  };
  return cached;
}

/** Headers to merge into every API request so the server can attribute the call. */
export function clientHeaders(): Record<string, string> {
  const ctx = clientContext();
  return {
    'User-Agent': `gipity-cli/${ctx.cli} (${ctx.os}; ${ctx.arch}; harness=${ctx.harness})`,
    'X-Gipity-Client': JSON.stringify(ctx),
  };
}

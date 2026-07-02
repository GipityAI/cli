/**
 * Claude Code install + detection helpers, shared by `gipity claude` (which
 * auto-ensures Claude Code before launching) and `gipity doctor` (which reports
 * Claude state). Centralizing here means a GUI/installer — e.g. the desktop
 * onboarding client — drives Claude setup through the CLI instead of
 * re-implementing it.
 *
 * The plan (`claudeInstallPlan`) is pure + unit-tested; actually running
 * `which`/`npm` happens in the helpers below and in the command layer.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';

export interface ClaudeInstallPlan {
  /** Shell command to check whether `claude` is on PATH. */
  checkCmd: string;
  /** Argv (no shell) to install Claude Code globally via npm. */
  installArgv: string[];
}

/** Pure: the platform-appropriate detect + install commands. Unit-tested. */
export function claudeInstallPlan(platformOverride?: string): ClaudeInstallPlan {
  const plat = platformOverride ?? process.platform;
  return {
    checkCmd: plat === 'win32' ? 'where claude' : 'which claude',
    installArgv: ['npm', 'install', '-g', CLAUDE_PACKAGE],
  };
}

/** Whether the `claude` binary resolves on PATH. */
export function isClaudeInstalled(platformOverride?: string): boolean {
  try {
    execSync(claudeInstallPlan(platformOverride).checkCmd, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort, positive-evidence-only check for "Claude Code is logged in."
 *
 * NOTE: on macOS the OAuth token can live in the Keychain, which we can't read
 * non-interactively — so a `false` here may be a false-negative. Callers should
 * treat `false` as "offer the login step" rather than "definitely logged out."
 * (Tracked as an open question in the desktop onboarding spec.)
 */
export function isClaudeAuthenticated(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}

/**
 * Definitive auth check: actually run a tiny headless `claude -p` ping. If it
 * returns output, Claude Code is authenticated. This is the reliable check
 * (unlike `isClaudeAuthenticated`'s file/env heuristic) but it's **billed** (a
 * real LLM call) and slow (network + model latency), so it's opt-in — use it at
 * a decision point (e.g. confirming the login step took), not on every poll.
 */
export function probeClaudeAuthenticated(): boolean {
  if (!isClaudeInstalled()) return false;
  try {
    const out = execSync('claude -p "Reply with the single word: PONG"', {
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
    });
    return typeof out === 'string' && out.trim().length > 0;
  } catch {
    // Non-zero exit (unauthenticated, network error, etc.) → treat as not auth'd.
    return false;
  }
}

export interface EnsureClaudeResult {
  /** True if `claude` is available after this call. */
  installed: boolean;
  /** True if it was already present and no install was attempted. */
  alreadyPresent: boolean;
}

/**
 * Install Claude Code via npm if it isn't already on PATH. Idempotent: a no-op
 * (beyond the PATH check) when already present, unless `force`. `quiet`
 * suppresses npm's output (for headless/GUI callers); default streams it.
 */
export function ensureClaudeInstalled(opts: { force?: boolean; quiet?: boolean } = {}): EnsureClaudeResult {
  if (!opts.force && isClaudeInstalled()) return { installed: true, alreadyPresent: true };
  const { installArgv } = claudeInstallPlan();
  try {
    execSync(installArgv.join(' '), { stdio: opts.quiet ? 'ignore' : 'inherit', windowsHide: true });
  } catch {
    // Fall through to a definitive PATH re-check rather than trusting the throw.
  }
  return { installed: isClaudeInstalled(), alreadyPresent: false };
}

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
import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveCommand, spawnCommand } from './platform.js';

export const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';

/** `claude auth status` is a local credential read (no LLM call, not billed),
 *  but it is still a process spawn - budget a few seconds and treat an overrun
 *  as "unknown". */
const AUTH_STATUS_TIMEOUT_MS = 15_000;

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

/** What `claude auth status --json` reports. Only `loggedIn` is relied on; the
 *  rest is useful context for diagnostics and support ("which account is this
 *  machine on?"). */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/**
 * Ask Claude Code itself whether it is logged in.
 *
 * This is the authoritative check: Claude Code reads its OWN credential store,
 * so it works on macOS (Keychain) where an outside file probe cannot, and it
 * reflects a revoked or lapsed token that a file-existence check would happily
 * call "logged in". It is NOT billed (no LLM call) but it does spawn a process
 * and costs ~2s, so call it on the failure path or the periodic heartbeat, not
 * on every dispatch.
 *
 * Returns null when the question can't be answered (Claude Code absent, or too
 * old to have `auth status`) so callers can distinguish "definitely logged out"
 * from "don't know" instead of reporting a confident wrong answer.
 */
export function claudeAuthStatus(): ClaudeAuthStatus | null {
  if (!isClaudeInstalled()) return null;
  try {
    return parseClaudeAuthStatus(execSync('claude auth status --json', {
      timeout: AUTH_STATUS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
    }));
  } catch {
    // Non-zero exit, timeout, or unparseable output (an older Claude Code with
    // no `auth status` subcommand). Unknown, not "logged out".
    return null;
  }
}

/** Async twin of {@link claudeAuthStatus}, for callers that share an event loop
 *  with other work. The relay daemon runs its heartbeat, dispatch and
 *  cancellation loops on ONE loop, so a ~2s execSync there would freeze all of
 *  them (the same reason diagnostics probes are async). Never rejects. */
export function claudeAuthStatusAsync(): Promise<ClaudeAuthStatus | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: ClaudeAuthStatus | null) => { if (!settled) { settled = true; resolve(v); } };
    let child: ChildProcess;
    try {
      child = spawnCommand(resolveCommand('claude'), ['auth', 'status', '--json'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(null);
    }, AUTH_STATUS_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => { clearTimeout(timer); done(parseClaudeAuthStatus(out)); });
  });
}

/** Parse `claude auth status --json`. Returns null on anything unexpected, so
 *  "couldn't tell" never masquerades as "logged out". Exported for tests. */
export function parseClaudeAuthStatus(out: string): ClaudeAuthStatus | null {
  try {
    const parsed = JSON.parse(out) as Partial<ClaudeAuthStatus>;
    if (typeof parsed?.loggedIn !== 'boolean') return null;
    return {
      loggedIn: parsed.loggedIn,
      authMethod: parsed.authMethod,
      email: parsed.email,
      subscriptionType: parsed.subscriptionType,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort, positive-evidence-only check for "Claude Code is logged in."
 *
 * Prefers `claude auth status` (authoritative, sees the Keychain, notices a
 * revoked token) and falls back to the old env/file heuristic only when that
 * can't answer, e.g. a Claude Code too old to have the subcommand. The
 * fallback keeps the original caveat: on macOS the OAuth token can live in the
 * Keychain, which we can't read, so a `false` from the FALLBACK may be a
 * false-negative. Callers wanting certainty should use claudeAuthStatus()
 * directly and treat null as "unknown".
 */
export function isClaudeAuthenticated(): boolean {
  return claudeAuthStatus()?.loggedIn ?? claudeCredentialHeuristic();
}

/** The pre-`auth status` fallback: an env token, or a credentials file on disk.
 *  Cheap (no spawn) but blind to the macOS Keychain and to revoked tokens, so
 *  it is only correct as a LAST resort. Exported so a caller that has already
 *  paid for claudeAuthStatus() can fall back without spawning it a second time. */
export function claudeCredentialHeuristic(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}

/** The actionable "log in to Claude Code" line. `deviceName` names the machine
 *  that needs it, because the person reading this is usually in a browser on a
 *  DIFFERENT machine: Claude Code's own "run /login" is advice for someone
 *  sitting at a Claude Code prompt, which the reader is not. The login is an
 *  interactive browser flow, so it has to happen on that machine by hand. */
export function claudeLoginHint(deviceName?: string): string {
  const where = deviceName ? `on ${deviceName}` : 'on that machine';
  return `Claude Code is not logged in ${where}. Run \`claude auth login\` there `
    + 'and sign in, then send this again.';
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

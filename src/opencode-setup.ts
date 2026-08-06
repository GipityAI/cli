/**
 * opencode install + integration helpers, shared by `gipity build --agent
 * opencode` (auto-ensures opencode before launching) and the opencode
 * adapter's setup surface.
 *
 * The integration has three legs, all idempotent and best-effort:
 *
 *  1. Skills: opencode reads the cross-agent ~/.agents/skills directory
 *     natively (same SKILL.md family Codex/OpenClaw use), so it shares the
 *     Codex skills install (setup.ts installSkillsAndHooks).
 *  2. Plugin: the Gipity opencode plugin (auth + session capture + the
 *     "gipity" model provider) ships in the GipityAI/skills repo as
 *     hooks/scripts/opencode-plugin.mjs, is staged into ~/.gipity/agent-hooks
 *     by the skills install, and is copied from there into opencode's global
 *     plugin dir (~/.config/opencode/plugins/gipity.js).
 *  3. Model token: a long-lived gip_at_* agent API token minted for the
 *     model slot, stored 0600 at ~/.gipity/opencode-token.json. The plugin
 *     reads it (env GIPITY_TOKEN wins, e.g. under a relay daemon) and feeds
 *     it to the "gipity" provider as the API key, so opencode's model picker
 *     can run the curated open models billed via the user's Gipity credits.
 */
import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { homedir, hostname } from 'os';
import { dirname, join } from 'path';
import { AGENT_HOOKS_DIR } from './setup.js';
import { post } from './api.js';
import { getAuth } from './auth.js';
import { resolveApiBase } from './config.js';

export const OPENCODE_PACKAGE = 'opencode-ai';

/** opencode's global config root (its own convention: $XDG_CONFIG_HOME or
 *  ~/.config, then /opencode). */
export function opencodeConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'opencode');
}

/** Where the Gipity plugin lands inside opencode's global plugin dir. */
export function opencodePluginDest(): string {
  return join(opencodeConfigDir(), 'plugins', 'gipity.js');
}

/** The staged plugin source (installed by setup.ts installSkillsAndHooks
 *  alongside capture.cjs and friends). */
export function stagedPluginPath(): string {
  return join(AGENT_HOOKS_DIR, 'opencode-plugin.mjs');
}

/** The model-slot token file the plugin reads. Owner-only: it holds a
 *  long-lived agent API token. */
export const OPENCODE_TOKEN_FILE = join(
  process.env.GIPITY_DIR || join(homedir(), '.gipity'),
  'opencode-token.json',
);

/** Model tokens self-expire so an orphaned file (user wipes ~/.gipity, we
 *  lose the guid to revoke with) doesn't live forever. Launch re-mints on
 *  expiry - see ensureOpencodeModelToken(). */
const MODEL_TOKEN_EXPIRY_DAYS = 90;

export function isOpencodeInstalled(): boolean {
  const cmd = process.platform === 'win32' ? 'where opencode' : 'which opencode';
  try {
    execSync(cmd, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Install opencode via npm if it isn't already on PATH. Idempotent, same
 *  shape as ensureClaudeInstalled(). Vanilla opencode - never a fork. */
export function ensureOpencodeInstalled(opts: { quiet?: boolean } = {}): boolean {
  if (isOpencodeInstalled()) return true;
  try {
    execSync(`npm install -g ${OPENCODE_PACKAGE}`, {
      stdio: opts.quiet ? 'ignore' : 'inherit',
      windowsHide: true,
    });
  } catch { /* fall through to the definitive re-check */ }
  return isOpencodeInstalled();
}

/** Copy the staged Gipity plugin into opencode's global plugin dir. Returns
 *  true when the plugin is in place after the call. Content-compared so the
 *  steady-state cost is two file reads. */
export function ensureOpencodePluginInstalled(): boolean {
  const src = stagedPluginPath();
  if (!existsSync(src)) {
    const installed = existsSync(opencodePluginDest());
    if (!installed) {
      // Never fail silently here: without the plugin, opencode sessions run
      // fine but record nothing, which looks identical to "working".
      console.warn(
        'Gipity opencode plugin is not staged (skills install incomplete?) - session capture is off. Re-run `gipity init` with network access to fix.',
      );
    }
    return installed;
  }
  const dest = opencodePluginDest();
  try {
    if (existsSync(dest) && readFileSync(dest, 'utf-8') === readFileSync(src, 'utf-8')) return true;
    mkdirSync(join(opencodeConfigDir(), 'plugins'), { recursive: true });
    copyFileSync(src, dest);
    console.log('Installed the Gipity plugin for opencode (models + session capture).');
    return true;
  } catch {
    return existsSync(dest);
  }
}

export function opencodePluginState(): { current: boolean } {
  const src = stagedPluginPath();
  const dest = opencodePluginDest();
  try {
    return { current: existsSync(dest) && (!existsSync(src) || readFileSync(dest, 'utf-8') === readFileSync(src, 'utf-8')) };
  } catch {
    return { current: false };
  }
}

export function removeOpencodePlugin(): boolean {
  const dest = opencodePluginDest();
  if (!existsSync(dest)) return false;
  try { unlinkSync(dest); } catch { return false; }
  return true;
}

interface StoredModelToken { token: string; guid: string; mintedAt: string }

export function readOpencodeModelToken(): StoredModelToken | null {
  try {
    const parsed = JSON.parse(readFileSync(OPENCODE_TOKEN_FILE, 'utf-8'));
    return typeof parsed?.token === 'string' && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a valid model-slot token exists, minting one when absent or dead.
 * Requires a logged-in session (minting uses normal session auth); silently
 * no-ops when logged out or offline - the plugin then falls back to
 * GIPITY_TOKEN env (the relay/devbox path) or reports auth missing.
 */
export async function ensureOpencodeModelToken(): Promise<string | null> {
  const existing = readOpencodeModelToken();
  if (existing) {
    // Only a definitive 401 discards a stored token - a network blip must
    // not trigger a re-mint storm (same rule as relay/agent-token.ts).
    try {
      const res = await fetch(`${resolveApiBase()}/users/me`, {
        headers: { Authorization: `Bearer ${existing.token}` },
      });
      if (res.status !== 401) return existing.token;
    } catch {
      return existing.token;
    }
  }

  if (!getAuth()) return null;
  try {
    const res = await post<{ data: { token: string; shortGuid: string } }>(
      '/auth/agent-tokens',
      { name: `opencode models on ${hostname()}`, expiresInDays: MODEL_TOKEN_EXPIRY_DAYS },
    );
    const stored: StoredModelToken = {
      token: res.data.token,
      guid: res.data.shortGuid,
      mintedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(OPENCODE_TOKEN_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(OPENCODE_TOKEN_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
    try { chmodSync(OPENCODE_TOKEN_FILE, 0o600); } catch { /* best-effort */ }
    return stored.token;
  } catch {
    return null;
  }
}

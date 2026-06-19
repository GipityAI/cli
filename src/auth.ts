import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { decodeJwtExp } from './utils.js';

export interface AuthData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO timestamp
}

// GIPITY_DIR lets a caller keep a SEPARATE auth context (its own auth.json) from
// the default ~/.gipity — e.g. GipRunner logging into a local dev server without
// clobbering your real (prod) login. Only the auth dir moves; HOME is untouched,
// so the `claude` subprocess and git/npm still use the real home.
const AUTH_DIR = process.env.GIPITY_DIR || join(homedir(), '.gipity');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

let cached: AuthData | null = null;

export function getAuth(): AuthData | null {
  if (cached) return cached;
  if (!existsSync(AUTH_FILE)) return null;
  try {
    cached = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
    return cached;
  } catch {
    return null;
  }
}

/** Read auth.json directly from disk, bypassing the in-process cache.
 *  The relay daemon's secret-redaction needs the *current* tokens: a child
 *  `gipity sync` / `gipity claude` process can refresh and rewrite the file
 *  mid-run, after which the daemon's cached `getAuth()` would be stale. */
export function readAuthFresh(): AuthData | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData): void {
  // Lock down to owner-only: this file holds the account access + 7-day refresh
  // tokens, so a default 0644/0755 would let any other local user read them.
  // (The relay state file already does this; auth.json is the more sensitive of
  // the two.) chmod after write to also tighten any pre-existing loose file.
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(AUTH_FILE, 0o600); } catch { /* best-effort on platforms without chmod */ }
  cached = data;
}

export function clearAuth(): void {
  try { unlinkSync(AUTH_FILE); } catch { /* already gone */ }
  cached = null;
}

/** True only when re-login is genuinely required: the refresh token itself
 *  has expired. Access-token expiry (`expiresAt`) is invisible to users —
 *  every API call renews it via refreshTokenIfNeeded() — so it must never be
 *  surfaced as a session warning. */
export function sessionExpired(): boolean {
  const auth = getAuth();
  if (!auth) return true;
  const exp = decodeJwtExp(auth.refreshToken);
  if (!exp) return false; // undecodable - let the refresh path decide
  return Date.now() > exp * 1000;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Renew the access token (5-min buffer) before an authenticated call, surviving
 *  the case that broke overnight fix-mode runs: MANY concurrent `gipity` processes
 *  (relay daemon, file-sync hook, parallel commands) sharing one ~/.gipity/auth.json.
 *  Refresh tokens are SINGLE-USE — the server rotates them, so when several siblings
 *  race to refresh the same token, the first wins and the rest get a 401. The old
 *  code trusted a stale in-process cache and, on that race, let the 401 reach the
 *  caller, whose handler called clearAuth() and DELETED the shared file — locking
 *  every sibling out mid-run ("Not logged in"). Fix: always read the file fresh, and
 *  retry the race/transient failures, re-reading each attempt so we ADOPT whatever
 *  token a sibling just rotated in rather than resubmitting the rotated-away one.
 *  Stays void / never throws / never clears auth: a genuine dead token still flows to
 *  the caller's existing 401 path (which messages "run: gipity login"). */
export async function refreshTokenIfNeeded(): Promise<void> {
  const auth = readAuthFresh();        // never the cache — a sibling may have rotated
  if (!auth) return;                   // not logged in - caller throws the clean error
  cached = auth;

  const buffer = 5 * 60 * 1000;        // refresh 5 min before the access token lapses
  const fresh = (a: AuthData) => Date.now() <= new Date(a.expiresAt).getTime() - buffer;
  if (fresh(auth)) return;

  // If the refresh token itself has expired, re-login is genuinely required; leave the
  // expired auth in place so the caller's existing 401 path prompts `gipity login`.
  const refreshExp = decodeJwtExp(auth.refreshToken);
  if (refreshExp && Date.now() > refreshExp * 1000) return;

  const { resolveApiBase } = await import('./config.js');
  const apiBase = resolveApiBase();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const cur = readAuthFresh();       // a sibling may have just refreshed for us
    if (cur && fresh(cur)) { cached = cur; return; }
    const refreshToken = cur?.refreshToken ?? auth.refreshToken;

    let res: Response;
    try {
      res = await fetch(`${apiBase}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      await delay(attempt * 300); continue;   // network blip - retry
    }

    if (res.ok) {
      const json = await res.json().catch(() => null) as { accessToken: string; refreshToken: string } | null;
      const exp = json && decodeJwtExp(json.accessToken);
      if (!json || !exp) { await delay(attempt * 300); continue; }
      saveAuth({ accessToken: json.accessToken, refreshToken: json.refreshToken, email: auth.email, expiresAt: new Date(exp * 1000).toISOString() });
      return;
    }

    // 401/403 → the refresh token was rejected outright (it was rotated away by a
    // sibling, or genuinely expired). Re-read once more in case a sibling's fresh
    // token just landed; otherwise stop and let the caller's 401 path re-login.
    if (res.status === 401 || res.status === 403) {
      const after = readAuthFresh();
      if (after && fresh(after)) { cached = after; return; }
      return;
    }

    await delay(attempt * 300);        // 5xx / unexpected → transient, retry
  }
  // Retries exhausted: leave the existing token. The caller's request will 401 and the
  // existing handler messages the user — we never delete the shared auth.json here.
}

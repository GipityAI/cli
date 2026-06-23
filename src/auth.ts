import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync, openSync, closeSync } from 'fs';
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
const AUTH_LOCK_FILE = join(AUTH_DIR, 'auth.lock');

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

// ─── Cross-process refresh lock ────────────────────────────────
// Serializes token refreshes across every `gipity` process that shares this
// ~/.gipity/auth.json (foreground commands, the file-sync hook, the relay
// daemon). Without it, siblings race to refresh the SINGLE-USE refresh token:
// the first wins and rotates it, the rest submit the now-dead token and 401.
// Retry-and-re-read alone left a window (a sibling could 401 before the winner
// finished writing the file). Holding the lock closes that window — siblings
// wait, then re-read and ADOPT the freshly-rotated token instead of refreshing.
const LOCK_WAIT_MS = 10_000;          // refresh is one quick round-trip; cap the wait
const LOCK_POLL_MS = 100;

/** Acquire the global auth-refresh lock. Returns a release fn, or null if we
 *  couldn't get it within the wait window (caller then proceeds best-effort —
 *  refresh must never block a command indefinitely). Mirrors sync.ts's advisory
 *  lock: O_EXCL create, PID payload, stale-holder reclaim. Exported for tests. */
export async function acquireRefreshLock(): Promise<(() => void) | null> {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(AUTH_LOCK_FILE, 'wx');   // fails if the file exists
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(AUTH_LOCK_FILE); } catch { /* already gone */ } };
    } catch {
      // Lock held (or a transient create error). Reclaim it if the holder PID is dead.
      try {
        const pid = parseInt(readFileSync(AUTH_LOCK_FILE, 'utf-8').trim(), 10);
        if (pid && !isNaN(pid)) {
          try { process.kill(pid, 0); }
          catch { try { unlinkSync(AUTH_LOCK_FILE); } catch { /* race */ } continue; }
        }
      } catch { /* unreadable - retry */ }

      if (Date.now() - start > LOCK_WAIT_MS) return null;  // give up waiting, proceed best-effort
      await delay(LOCK_POLL_MS);
    }
  }
}

/** Renew the access token (5-min buffer) before an authenticated call, surviving
 *  the case that broke overnight fix-mode runs: MANY concurrent `gipity` processes
 *  (relay daemon, file-sync hook, parallel commands) sharing one ~/.gipity/auth.json.
 *  Refresh tokens are SINGLE-USE — the server rotates them, so when several siblings
 *  race to refresh the same token, the first wins and the rest get a 401. We guard
 *  the refresh with a cross-process lock so only one sibling refreshes at a time; the
 *  others wait, re-read the file, and ADOPT the freshly-rotated token. If the lock
 *  can't be had in time we still try (re-reading first), so this never hangs a command.
 *  Stays void / never throws / never clears auth: a genuine dead token still flows to
 *  the caller's existing 401 path (which messages "run: gipity login"). */
export async function refreshTokenIfNeeded(): Promise<void> {
  const auth = readAuthFresh();        // never the cache — a sibling may have rotated
  if (!auth) return;                   // not logged in - caller throws the clean error
  cached = auth;

  const buffer = 5 * 60 * 1000;        // refresh 5 min before the access token lapses
  const fresh = (a: AuthData) => Date.now() <= new Date(a.expiresAt).getTime() - buffer;
  if (fresh(auth)) return;             // fast path: token still good, no lock needed

  // If the refresh token itself has expired, re-login is genuinely required; leave the
  // expired auth in place so the caller's existing 401 path prompts `gipity login`.
  const refreshExp = decodeJwtExp(auth.refreshToken);
  if (refreshExp && Date.now() > refreshExp * 1000) return;

  // Serialize with sibling processes so we don't race the single-use refresh token.
  const release = await acquireRefreshLock();
  try {
    // Re-check under the lock: a sibling may have refreshed while we waited.
    const held = readAuthFresh();
    if (held && fresh(held)) { cached = held; return; }

    const { resolveApiBase } = await import('./config.js');
    const apiBase = resolveApiBase();

    for (let attempt = 1; attempt <= 3; attempt++) {
      const cur = readAuthFresh();     // a sibling may have just refreshed for us
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

      // 401/403 → the refresh token was rejected outright (rotated away by a sibling
      // that beat us to the lock, or genuinely expired). Re-read once more in case a
      // sibling's fresh token just landed; otherwise stop and let the caller re-login.
      if (res.status === 401 || res.status === 403) {
        const after = readAuthFresh();
        if (after && fresh(after)) { cached = after; return; }
        return;
      }

      await delay(attempt * 300);      // 5xx / unexpected → transient, retry
    }
    // Retries exhausted: leave the existing token. The caller's request will 401 and the
    // existing handler messages the user — we never delete the shared auth.json here.
  } finally {
    if (release) release();
  }
}

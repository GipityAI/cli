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

const AUTH_DIR = join(homedir(), '.gipity');
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

export function isExpired(): boolean {
  const auth = getAuth();
  if (!auth) return true;
  const expiresAt = new Date(auth.expiresAt).getTime();
  const buffer = 5 * 60 * 1000; // 5 minute buffer
  return Date.now() > expiresAt - buffer;
}

/** True only when re-login is genuinely required: the refresh token itself
 *  has expired. Access-token expiry (`expiresAt` / isExpired) is invisible
 *  to users — every API call renews it via refreshTokenIfNeeded() — so it
 *  must never be surfaced as a session warning. */
export function sessionExpired(): boolean {
  const auth = getAuth();
  if (!auth) return true;
  const exp = decodeJwtExp(auth.refreshToken);
  if (!exp) return false; // undecodable - let the refresh path decide
  return Date.now() > exp * 1000;
}

export async function refreshTokenIfNeeded(): Promise<void> {
  if (!isExpired()) return;

  const auth = getAuth();
  if (!auth) return; // not logged in, caller will handle

  try {
    const config = await import('./config.js');
    const apiBase = config.resolveApiBase();

    const res = await fetch(`${apiBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });

    if (!res.ok) {
      cached = null; // force re-login
      return;
    }

    const json = await res.json() as { accessToken: string; refreshToken: string };

    const exp = decodeJwtExp(json.accessToken);
    if (!exp) { cached = null; return; }
    const expiresAt = new Date(exp * 1000).toISOString();

    saveAuth({
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
      email: auth.email,
      expiresAt,
    });
  } catch {
    // Refresh failed - caller will see expired auth
  }
}

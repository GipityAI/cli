import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
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

export function saveAuth(data: AuthData): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
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

export function getTimeRemaining(): string {
  const auth = getAuth();
  if (!auth) return 'not authenticated';
  const ms = new Date(auth.expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m remaining`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m remaining`;
}

export async function refreshTokenIfNeeded(): Promise<void> {
  if (!isExpired()) return;

  const auth = getAuth();
  if (!auth) return; // not logged in, caller will handle

  try {
    const config = await import('./config.js');
    const cfg = config.getConfig();
    const apiBase = cfg?.apiBase || 'https://a.gipity.ai';

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
    // Refresh failed — caller will see expired auth
  }
}

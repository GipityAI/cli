/**
 * Interactive email+code login, shared by every command that may need to log a
 * user in mid-run (`gipity claude`, `gipity setup`). Kept in one place so the
 * prompts, indentation, and token handling never drift between entry points.
 *
 * Distinct from `commands/login.ts` (the standalone `gipity login`, which also
 * supports non-interactive `--email/--code`): this variant is the two-space
 * indented, always-interactive flow used as a sub-step of a larger command, and
 * it returns the fresh `AuthData` instead of exiting.
 */
import { publicPost } from './api.js';
import { getAuth, saveAuth, type AuthData } from './auth.js';
import { prompt, decodeJwtExp } from './utils.js';
import { success, error as clrError, muted } from './colors.js';
import { flushBugQueue } from './bug-queue.js';

/** Prompt for email + 6-digit code, persist the tokens, and return the new
 *  auth. Exits the process on empty input or a bad token (the caller can't
 *  proceed without a session). */
export async function interactiveLogin(): Promise<AuthData> {
  const email = await prompt('  Email: ');
  if (!email) { console.error(`\n  ${clrError('Email required.')}`); process.exit(1); }

  await publicPost('/auth/login', { email });
  console.log('  Check your email for a 6-digit code.\n');

  const code = await prompt('  Code: ');
  if (!code) { console.error(`\n  ${clrError('Code required.')}`); process.exit(1); }

  const res = await publicPost<{
    accessToken: string;
    refreshToken: string;
    isNewUser: boolean;
  }>('/auth/verify', { email, code });

  const exp = decodeJwtExp(res.accessToken);
  if (!exp) { console.error(`\n  ${clrError('Invalid token received.')}`); process.exit(1); }
  const expiresAt = new Date(exp * 1000).toISOString();

  saveAuth({ accessToken: res.accessToken, refreshToken: res.refreshToken, email, expiresAt });
  console.log(`  ${success(`Logged in (${email}).`)}`);

  const delivered = await flushBugQueue().catch(() => 0);
  if (delivered > 0) {
    console.log(`  ${muted(`Delivered ${delivered} queued bug report${delivered === 1 ? '' : 's'}.`)}`);
  }

  return getAuth()!;
}

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
import { getConfig } from './config.js';
import { prompt, decodeJwtExp } from './utils.js';
import { success, error as clrError, warning, muted } from './colors.js';
import { flushBugQueue } from './bug-queue.js';

/** True when a fresh-account result would be a SURPRISE worth warning about:
 *  either this directory is linked to an existing project, or this machine
 *  already held a session for this exact email. A genuine first-time signup
 *  (nothing linked, no prior session) must stay silent. */
function newAccountWouldBeUnexpected(email: string, priorAuth: AuthData | null): boolean {
  return !!getConfig() || priorAuth?.email.toLowerCase() === email.toLowerCase().trim();
}

/** Called right after `/auth/login` (send-code), before the code is entered -
 *  the server already knows at this point whether the email matches an
 *  existing account (bug cli#S2: logging into the wrong/new account was
 *  previously silent until a later "not found" error). */
export function warnBeforeCodeIfUnexpectedNewAccount(isNewUser: boolean | undefined, email: string, indent = ''): void {
  if (isNewUser !== true) return;
  const priorAuth = getAuth();
  if (!newAccountWouldBeUnexpected(email, priorAuth)) return;
  const config = getConfig();
  console.log(`${indent}${warning(`No existing Gipity account for ${email} — entering the code will CREATE a new one.`)}`);
  if (config) {
    console.log(`${indent}${muted(`This directory is linked to project ${config.projectSlug} (account ${config.accountSlug}). If you meant to log into that account, stop and re-check the email before entering the code.`)}`);
  }
}

/** Called right after `/auth/verify` succeeds. `priorAuth` must be captured
 *  BEFORE `saveAuth()` overwrites the cache - it's the only way to tell "this
 *  machine already had a session for this email" from "first login ever". */
export function warnIfUnexpectedNewAccount(isNewUser: boolean | undefined, email: string, priorAuth: AuthData | null, indent = ''): void {
  if (isNewUser !== true) return;
  if (!newAccountWouldBeUnexpected(email, priorAuth)) return;
  const config = getConfig();
  console.log(`${indent}${warning(`Logged into a NEW, empty account for ${email} — no prior account existed for this email.`)}`);
  if (config) {
    console.log(`${indent}${muted(`This directory is linked to project ${config.projectSlug} (account ${config.accountSlug}), which the new account does not own — project / skill / sync commands will fail with "not found".`)}`);
  }
  console.log(`${indent}${muted('If you expected an existing account, run: gipity status  — then gipity login again with the correct email.')}`);
}

/** Prompt for email + 6-digit code, persist the tokens, and return the new
 *  auth. Exits the process on empty input or a bad token (the caller can't
 *  proceed without a session). */
export async function interactiveLogin(): Promise<AuthData> {
  const email = await prompt('  Email: ');
  if (!email) { console.error(`\n  ${clrError('Email required.')}`); process.exit(1); }

  const sendRes = await publicPost<{ isNewUser?: boolean }>('/auth/login', { email });
  console.log('  Check your email for a 6-digit code.\n');
  warnBeforeCodeIfUnexpectedNewAccount(sendRes.isNewUser, email, '  ');

  const code = await prompt('  Code: ');
  if (!code) { console.error(`\n  ${clrError('Code required.')}`); process.exit(1); }

  const priorAuth = getAuth();
  const res = await publicPost<{
    accessToken: string;
    refreshToken: string;
    isNewUser?: boolean;
  }>('/auth/verify', { email, code });

  const exp = decodeJwtExp(res.accessToken);
  if (!exp) { console.error(`\n  ${clrError('Invalid token received.')}`); process.exit(1); }
  const expiresAt = new Date(exp * 1000).toISOString();

  saveAuth({ accessToken: res.accessToken, refreshToken: res.refreshToken, email, expiresAt });
  console.log(`  ${success(`Logged in (${email}).`)}`);
  warnIfUnexpectedNewAccount(res.isNewUser, email, priorAuth, '  ');

  const delivered = await flushBugQueue().catch(() => 0);
  if (delivered > 0) {
    console.log(`  ${muted(`Delivered ${delivered} queued bug report${delivered === 1 ? '' : 's'}.`)}`);
  }

  return getAuth()!;
}

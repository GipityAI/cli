/**
 * Email-code verification for `gipity login` (and the interactive login used by
 * `gipity setup` / `gipity claude`), including accounts that require a passkey.
 *
 * Such an account does not get tokens for a correct code. The server answers
 * with a verificationUrl on the API host and a pollToken instead: the user
 * opens the URL, confirms with their passkey (or the recovery code), and the
 * CLI polls `POST /auth/passkey/poll` until the server hands over the token
 * pair (device flow, like `gh auth login`). The CLI never sees a passkey.
 */
import { publicPost, ApiError } from './api.js';
import { openInBrowser } from './platform.js';
import { bold, muted } from './colors.js';

export interface LoginTokens {
  accessToken: string;
  refreshToken: string;
  isNewUser?: boolean;
  /** True when the sign-in went through the passkey step. */
  passkey?: boolean;
}

interface VerifyResponse {
  accessToken?: string;
  refreshToken?: string;
  isNewUser?: boolean;
  passkeyRequired?: boolean;
  verificationUrl?: string;
  pollToken?: string;
  interval?: number;
  expiresIn?: number;
}

type PollResponse =
  | { status: 'pending'; interval?: number }
  | { status: 'complete'; accessToken: string; refreshToken: string; email: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open the browser only for a person at a terminal (never for an agent or a test). */
function shouldOpenBrowser(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.GIPITY_NO_BROWSER;
}

/** Verify an email code; finish the passkey step first if the account requires one. */
export async function verifyEmailCode(
  email: string,
  code: string,
  say: (line: string) => void,
  indent = '',
): Promise<LoginTokens> {
  const res = await publicPost<VerifyResponse>('/auth/verify', { email, code, client: 'cli' });
  if (!res.passkeyRequired) {
    if (!res.accessToken || !res.refreshToken) throw new Error('The server did not return a session.');
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, isNewUser: res.isNewUser };
  }
  if (!res.verificationUrl || !res.pollToken) throw new Error('The server asked for a passkey but sent no sign-in link.');

  say(`${indent}${bold('This account requires a passkey to sign in.')}`);
  say(`${indent}Open this link and confirm with your passkey (or your recovery code):`);
  say(`${indent}  ${res.verificationUrl}`);
  if (shouldOpenBrowser()) openInBrowser(res.verificationUrl);
  say(`${indent}${muted('Waiting for you to finish in the browser...')}`);

  const tokens = await pollUntilDone(res.pollToken, res.interval ?? 2, res.expiresIn ?? 600);
  return { ...tokens, isNewUser: false, passkey: true };
}

async function pollUntilDone(pollToken: string, intervalS: number, expiresInS: number): Promise<{ accessToken: string; refreshToken: string }> {
  const deadline = Date.now() + expiresInS * 1000;
  let waitMs = Math.max(200, intervalS * 1000);
  while (Date.now() < deadline) {
    await sleep(waitMs);
    let res: PollResponse;
    try {
      res = await publicPost<PollResponse>('/auth/passkey/poll', { pollToken });
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 410) {
        throw new Error('The passkey sign-in expired or was cancelled. Run gipity login again.');
      }
      throw err;
    }
    if (res.status === 'complete') return { accessToken: res.accessToken, refreshToken: res.refreshToken };
    if (typeof res.interval === 'number') waitMs = Math.max(200, res.interval * 1000);
  }
  throw new Error('The passkey sign-in expired. Run gipity login again.');
}

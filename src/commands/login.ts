import { Command } from 'commander';
import { saveAuth, getAuth } from '../auth.js';
import { publicPost } from '../api.js';
import { prompt, decodeJwtExp } from '../utils.js';
import { success, error as clrError, muted } from '../colors.js';
import { flushBugQueue } from '../bug-queue.js';
import { warnBeforeCodeIfUnexpectedNewAccount, warnIfUnexpectedNewAccount } from '../login-flow.js';

export const loginCommand = new Command('login')
  .description('Log in or sign up')
  .option('--email <email>', 'Email address')
  .option('--code <code>', 'Verification code')
  .option('--json', 'Output as JSON (prompts and warnings go to stderr)')
  .action(async (opts) => {
    const json = !!opts.json;
    // In JSON mode stdout carries only the final result object; every human
    // line (instructions, prompts, new-account warnings) goes to stderr.
    const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
    const promptOut = json ? process.stderr : process.stdout;
    try {
      let email = opts.email;
      let code = opts.code;

      // Both provided → verify immediately (non-interactive, ideal for scripts/CC)
      if (email && code) {
        await verify(email, code, json, say);
        return;
      }

      // Email only → send code and exit (non-interactive step 1)
      if (email && !code) {
        const sendRes = await publicPost<{ isNewUser?: boolean }>('/auth/login', { email });
        const next = `gipity login --email ${email} --code <code>`;
        if (json) {
          console.log(JSON.stringify({ codeSent: true, email, newAccount: sendRes.isNewUser === true, next }));
        } else {
          console.log('Check your email for a 6-digit code.');
          console.log(muted(`Then run: ${next}`));
        }
        warnBeforeCodeIfUnexpectedNewAccount(sendRes.isNewUser, email, '', say);
        return;
      }

      // Fully interactive flow
      say('Enter your email to log in or create an account.');

      const existing = getAuth();
      email = await prompt(existing ? `Email [${existing.email}]: ` : 'Email: ', promptOut);
      if (!email && existing) email = existing.email;
      if (!email) {
        console.error(clrError('Email required.'));
        process.exit(1);
      }

      const sendRes = await publicPost<{ isNewUser?: boolean }>('/auth/login', { email });
      say('');
      say('Check your email for a 6-digit code.');
      warnBeforeCodeIfUnexpectedNewAccount(sendRes.isNewUser, email, '', say);

      code = await prompt('Code: ', promptOut);
      await verify(email, code, json, say);
    } catch (err: any) {
      console.error(clrError(`Login failed: ${err.message}`));
      process.exit(1);
    }
  });

async function verify(email: string, code: string, json: boolean, say: (line: string) => void): Promise<void> {
  const priorAuth = getAuth();
  const res = await publicPost<{
    accessToken: string;
    refreshToken: string;
    isNewUser?: boolean;
  }>('/auth/verify', { email, code });

  const exp = decodeJwtExp(res.accessToken);
  if (!exp) {
    console.error(clrError('Invalid token received.'));
    process.exit(1);
  }
  const expiresAt = new Date(exp * 1000).toISOString();

  saveAuth({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    email,
    expiresAt,
  });

  if (!json) console.log(success(`Logged in (${email}).`));
  warnIfUnexpectedNewAccount(res.isNewUser, email, priorAuth, '', say);

  // A fresh session is the clearest "we're reconnected" signal - clear any bug
  // reports that got stranded while this account's session was expired/offline.
  const delivered = await flushBugQueue().catch(() => 0);
  if (json) {
    console.log(JSON.stringify({ loggedIn: true, email, newAccount: res.isNewUser === true, expiresAt, queuedBugReportsDelivered: delivered }));
    return;
  }
  if (delivered > 0) {
    console.log(muted(`Delivered ${delivered} queued bug report${delivered === 1 ? '' : 's'}.`));
  }
}

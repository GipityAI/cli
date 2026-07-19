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
  .action(async (opts) => {
    try {
      let email = opts.email;
      let code = opts.code;

      // Both provided → verify immediately (non-interactive, ideal for scripts/CC)
      if (email && code) {
        await verify(email, code);
        return;
      }

      // Email only → send code and exit (non-interactive step 1)
      if (email && !code) {
        const sendRes = await publicPost<{ isNewUser?: boolean }>('/auth/login', { email });
        console.log('Check your email for a 6-digit code.');
        console.log(muted(`Then run: gipity login --email ${email} --code <code>`));
        warnBeforeCodeIfUnexpectedNewAccount(sendRes.isNewUser, email);
        return;
      }

      // Fully interactive flow
      console.log('Enter your email to log in or create an account.');

      const existing = getAuth();
      email = await prompt(existing ? `Email [${existing.email}]: ` : 'Email: ');
      if (!email && existing) email = existing.email;
      if (!email) {
        console.error(clrError('Email required.'));
        process.exit(1);
      }

      const sendRes = await publicPost<{ isNewUser?: boolean }>('/auth/login', { email });
      console.log('');
      console.log('Check your email for a 6-digit code.');
      warnBeforeCodeIfUnexpectedNewAccount(sendRes.isNewUser, email);

      code = await prompt('Code: ');
      await verify(email, code);
    } catch (err: any) {
      console.error(clrError(`Login failed: ${err.message}`));
      process.exit(1);
    }
  });

async function verify(email: string, code: string): Promise<void> {
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

  console.log(success(`Logged in (${email}).`));
  warnIfUnexpectedNewAccount(res.isNewUser, email, priorAuth);

  // A fresh session is the clearest "we're reconnected" signal - clear any bug
  // reports that got stranded while this account's session was expired/offline.
  const delivered = await flushBugQueue().catch(() => 0);
  if (delivered > 0) {
    console.log(muted(`Delivered ${delivered} queued bug report${delivered === 1 ? '' : 's'}.`));
  }
}

import { Command } from 'commander';
import { saveAuth, getAuth } from '../auth.js';
import { publicPost } from '../api.js';
import { prompt, decodeJwtExp } from '../utils.js';
import { success, error as clrError, info } from '../colors.js';

export const loginCommand = new Command('login')
  .description('Authenticate with Gipity')
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
        await publicPost('/auth/login', { email });
        console.log(info(`Code sent to ${email}. Run: gipity login --email ${email} --code <code>`));
        return;
      }

      // Fully interactive flow
      if (!email) {
        const existing = getAuth();
        email = await prompt(existing ? `Email [${existing.email}]: ` : 'Email: ');
        if (!email && existing) email = existing.email;
        if (!email) { console.error(clrError('Email required.')); process.exit(1); }
      }

      await publicPost('/auth/login', { email });
      console.log(info('Check your email for a 6-digit code.'));

      code = await prompt('Code: ');
      await verify(email, code);
    } catch (err: any) {
      console.error(clrError(`Login failed: ${err.message}`));
      process.exit(1);
    }
  });

async function verify(email: string, code: string): Promise<void> {
  const res = await publicPost<{
    accessToken: string;
    refreshToken: string;
    isNewUser: boolean;
  }>('/auth/verify', { email, code });

  const exp = decodeJwtExp(res.accessToken);
  if (!exp) { console.error(clrError('Invalid token received.')); process.exit(1); }
  const expiresAt = new Date(exp * 1000).toISOString();

  saveAuth({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    email,
    expiresAt,
  });

  console.log(success(`Authenticated as ${email}`));
}

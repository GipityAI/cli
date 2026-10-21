import { Command } from 'commander';
import { getAuth, clearAuth } from '../auth.js';
import { success } from '../colors.js';

export const logoutCommand = new Command('logout')
  .description('Log out')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const auth = getAuth();
    if (auth) clearAuth();
    if (opts.json) {
      console.log(JSON.stringify({ loggedOut: !!auth, email: auth?.email ?? null }));
      return;
    }
    console.log(auth ? success(`Logged out (${auth.email}).`) : 'Not logged in.');
  });

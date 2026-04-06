import { Command } from 'commander';
import { getAuth, clearAuth } from '../auth.js';

export const logoutCommand = new Command('logout')
  .description('Log out and clear stored credentials')
  .action(() => {
    const auth = getAuth();
    if (!auth) {
      console.log('Not logged in.');
      return;
    }
    clearAuth();
    console.log(`Logged out (${auth.email}).`);
  });

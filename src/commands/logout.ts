import { Command } from 'commander';
import { getAuth, clearAuth } from '../auth.js';
import { success } from '../colors.js';

export const logoutCommand = new Command('logout')
  .description('Log out')
  .action(() => {
    const auth = getAuth();
    if (!auth) {
      console.log('Not logged in.');
    } else {
      clearAuth();
      console.log(success(`Logged out (${auth.email}).`));
    }
  });

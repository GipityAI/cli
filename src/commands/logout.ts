import { Command } from 'commander';
import { getAuth, clearAuth } from '../auth.js';

export const logoutCommand = new Command('logout')
  .description('Log out')
  .action(() => {
    const auth = getAuth();
    console.log('');
    if (!auth) {
      console.log('Not logged in.');
    } else {
      clearAuth();
      console.log(`Logged out (${auth.email}).`);
    }
    console.log('');
  });

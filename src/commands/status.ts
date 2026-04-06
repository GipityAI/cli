import { Command } from 'commander';
import { getAuth, getTimeRemaining } from '../auth.js';
import { getConfig } from '../config.js';

export const statusCommand = new Command('status')
  .description('Show project and auth status')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const config = getConfig();
    const auth = getAuth();

    if (opts.json) {
      console.log(JSON.stringify({
        project: config ? {
          guid: config.projectGuid,
          slug: config.projectSlug,
          account: config.accountSlug,
          apiBase: config.apiBase,
        } : null,
        auth: auth ? {
          email: auth.email,
          expiresAt: auth.expiresAt,
          valid: new Date(auth.expiresAt).getTime() > Date.now(),
        } : null,
      }, null, 2));
      return;
    }

    if (!config) {
      console.log('Not a Gipity project. Run: gipity init');
    } else {
      console.log(`Project: ${config.projectSlug} (${config.projectGuid})`);
      console.log(`Account: ${config.accountSlug}`);
      console.log(`API: ${config.apiBase}`);
      if (config.agentGuid) console.log(`Agent: ${config.agentGuid}`);
    }

    if (!auth) {
      console.log('Auth: not logged in. Run: gipity login');
    } else {
      console.log(`Auth: ${auth.email} (${getTimeRemaining()})`);
    }
  });

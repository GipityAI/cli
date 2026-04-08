import { Command } from 'commander';
import { getAuth, getTimeRemaining } from '../auth.js';
import { getConfig } from '../config.js';
import { brand, success, warning, muted, error as clrError } from '../colors.js';

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
      console.log(warning('Not a Gipity project. Run: gipity init'));
    } else {
      console.log(`${muted('Project:')} ${brand(config.projectSlug)} ${muted(`(${config.projectGuid})`)}`);
      console.log(`${muted('Account:')} ${config.accountSlug}`);
      console.log(`${muted('API:')} ${config.apiBase}`);
      if (config.agentGuid) console.log(`${muted('Agent:')} ${config.agentGuid}`);
    }

    if (!auth) {
      console.log(`${muted('Auth:')} ${warning('not logged in. Run: gipity login')}`);
    } else {
      console.log(`${muted('Auth:')} ${success(auth.email)} ${muted(`(${getTimeRemaining()})`)}`);
    }
  });

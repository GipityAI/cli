import { Command } from 'commander';
import { post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { error as clrError, success } from '../colors.js';

export const emailCommand = new Command('email')
  .description('Send an email to yourself')
  .requiredOption('--subject <subject>', 'Email subject')
  .requiredOption('--body <body>', 'Email body (plain text)')
  .option('--html <html>', 'Optional HTML body')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      await resolveProjectContext();
      const res = await post<{ data: { to: string; subject: string } }>('/agent-email/send', {
        subject: opts.subject,
        body: opts.body,
        html: opts.html,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        console.log(success(`Email sent to ${res.data.to}: ${res.data.subject}`));
      }
    } catch (err: any) {
      console.error(clrError(`Email failed: ${err.message}`));
      process.exit(1);
    }
  });

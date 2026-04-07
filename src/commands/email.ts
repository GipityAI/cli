import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';

export const emailCommand = new Command('email')
  .description('Send an email to yourself')
  .requiredOption('--subject <subject>', 'Email subject')
  .requiredOption('--body <body>', 'Email body (plain text)')
  .option('--html <html>', 'Optional HTML body')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      requireConfig();
      const res = await post<{ data: { to: string; subject: string } }>('/agent-email/send', {
        subject: opts.subject,
        body: opts.body,
        html: opts.html,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        console.log(`Email sent to ${res.data.to}: ${res.data.subject}`);
      }
    } catch (err: any) {
      console.error(`Email failed: ${err.message}`);
      process.exit(1);
    }
  });

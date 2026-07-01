import { Command } from 'commander';
import { post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { error as clrError, success } from '../colors.js';

/** Commander collector: build an array from repeated flags (--to a --to b). */
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export const emailCommand = new Command('email')
  .description('Send email')
  .addHelpText('after', '\nSends from gipity@gipity.ai. Omit --to to self-send.')
  .requiredOption('--subject <subject>', 'Email subject')
  .requiredOption('--body <body>', 'Email body (plain text)')
  .option('--to <email>', 'Recipient (repeatable; omit for self-send)', collect, [] as string[])
  .option('--cc <email>', 'Cc recipient (repeatable)', collect, [] as string[])
  .option('--bcc <email>', 'Bcc recipient (repeatable)', collect, [] as string[])
  .option('--reply-to <email>', 'Reply-To header address')
  .option('--html <html>', 'Optional HTML body')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      await resolveProjectContext();
      const payload: Record<string, unknown> = {
        subject: opts.subject,
        body: opts.body,
      };
      if (opts.to.length) payload.to = opts.to;
      if (opts.cc.length) payload.cc = opts.cc;
      if (opts.bcc.length) payload.bcc = opts.bcc;
      if (opts.replyTo) payload.reply_to = opts.replyTo;
      if (opts.html) payload.html = opts.html;

      const res = await post<{ data: { to: string[]; cc: string[]; bcc: string[]; subject: string } }>(
        '/agent-email/send', payload,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        const recap = res.data.to.join(', ')
          + (res.data.cc.length ? `, cc: ${res.data.cc.join(', ')}` : '')
          + (res.data.bcc.length ? `, bcc: ${res.data.bcc.length}` : '');
        console.log(success(`Email sent to ${recap}: ${res.data.subject}`));
      }
    } catch (err: any) {
      console.error(clrError(`Email failed: ${err.message}`));
      process.exit(1);
    }
  });

import { Command } from 'commander';
import { get, post } from '../api.js';
import { run, printList, printResult } from '../helpers/index.js';
import { muted } from '../colors.js';

/**
 * `gipity gmail` - send/reply/search/read using the user's OWN Gmail account
 * via the Google OAuth connection.
 *
 * This is DIFFERENT from `gipity email`, which sends from the Gipity platform
 * address (gipity@gipity.ai). Use `gmail` when you want the recipient to see
 * the user's personal/work address; use `email` for platform-owned messages.
 */

interface GmailSummary {
  id: string;
  from: string;
  subject: string | null;
  snippet?: string;
}

export const gmailCommand = new Command('gmail')
  .description('Use your Gmail')
  .addHelpText('after', '\nSend, reply, search, or read via your own Gmail (separate from `gipity email`).');

gmailCommand
  .command('search <query...>')
  .description('Search your Gmail (standard Gmail search syntax)')
  .option('--json', 'Output as JSON')
  .action((queryParts: string[], opts) => run('Search', async () => {
    const q = queryParts.join(' ');
    const res = await get<{ data: GmailSummary[] }>(`/gmail/search?q=${encodeURIComponent(q)}`);
    printList(res.data, opts, 'No messages matched.', m =>
      `${m.id}  ${m.from}  ${m.subject || muted('(no subject)')}`,
    );
  }));

gmailCommand
  .command('read <message-id>')
  .description('Read a Gmail message')
  .option('--json', 'Output as JSON')
  .action((messageId: string, opts) => run('Read', async () => {
    const res = await get<{ data: unknown }>(`/gmail/${encodeURIComponent(messageId)}`);
    if (opts.json) console.log(JSON.stringify(res.data));
    else console.log(JSON.stringify(res.data, null, 2));
  }));

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

gmailCommand
  .command('send')
  .description('Send a new email from your Gmail')
  .requiredOption('--to <email>', 'Recipient (repeatable)', collect, [] as string[])
  .option('--cc <email>', 'Cc recipient (repeatable)', collect, [] as string[])
  .option('--bcc <email>', 'Bcc recipient (repeatable)', collect, [] as string[])
  .option('--reply-to <email>', 'Reply-To header address')
  .requiredOption('--subject <s>', 'Subject line')
  .requiredOption('--body <text>', 'Email body')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Send', async () => {
    if (!opts.to.length) throw new Error('--to is required (pass at least one)');
    const payload: Record<string, unknown> = { to: opts.to, subject: opts.subject, body: opts.body };
    if (opts.cc.length) payload.cc = opts.cc;
    if (opts.bcc.length) payload.bcc = opts.bcc;
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    await post('/gmail/send', payload);
    const recap = opts.to.join(', ') + (opts.cc.length ? `, cc: ${opts.cc.join(', ')}` : '');
    printResult(`Sent from your Gmail to ${recap}.`, opts, { sent: true, to: opts.to });
  }));

gmailCommand
  .command('reply')
  .description('Reply to a Gmail thread. Get thread-id + message-id from `gmail search`.')
  .requiredOption('--thread-id <id>', 'Thread ID (from `gmail search`)')
  .requiredOption('--message-id <id>', 'Message ID being replied to (In-Reply-To)')
  .requiredOption('--to <email>', 'Recipient (repeatable)', collect, [] as string[])
  .option('--cc <email>', 'Cc recipient (repeatable)', collect, [] as string[])
  .option('--bcc <email>', 'Bcc recipient (repeatable)', collect, [] as string[])
  .option('--reply-to <email>', 'Reply-To header address')
  .requiredOption('--subject <s>', 'Subject (usually "Re: ..." of the original)')
  .requiredOption('--body <text>', 'Reply body (you compose the quote header)')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Reply', async () => {
    if (!opts.to.length) throw new Error('--to is required (pass at least one)');
    const payload: Record<string, unknown> = {
      thread_id: opts.threadId,
      message_id: opts.messageId,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
    };
    if (opts.cc.length) payload.cc = opts.cc;
    if (opts.bcc.length) payload.bcc = opts.bcc;
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    await post('/gmail/reply', payload);
    printResult('Reply sent.', opts, { sent: true, thread_id: opts.threadId });
  }));

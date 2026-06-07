import { Command } from 'commander';
import { get, post } from '../api.js';
import { muted, success } from '../colors.js';
import { run, printList, printResult } from '../helpers/index.js';

interface ApprovalSummary {
  guid: string;
  title: string;
  status: string;
  response_type: string;
  choices: string[] | null;
  created_at: string;
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function keyToIndex(key: string): number {
  if (key.length !== 1) return -1;
  const code = key.toLowerCase().charCodeAt(0) - 97;
  return code >= 0 && code < 26 ? code : -1;
}

export const approvalCommand = new Command('approval')
  .description('List, create, answer, or cancel approvals');

approvalCommand
  .command('list')
  .description('List pending approvals')
  .option('--status <status>', 'pending|approved|denied|cancelled|expired|all', 'pending')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const res = await get<{ data: ApprovalSummary[] }>(`/approvals?status=${encodeURIComponent(opts.status)}`);
    printList(res.data, opts, 'No approvals.', a =>
      `${a.guid}  ${a.title}  ${muted(`[${a.status}] ${timeAgo(a.created_at)}`)}`,
    );
  }));

approvalCommand
  .command('create <title...>')
  .description('Create a pending approval')
  .option('--description <text>', 'Detailed context')
  .option('--type <type>', 'yes_no | choice | text', 'yes_no')
  .option('--choices <a,b,c>', 'Comma-separated options (for --type choice)')
  .option('--prompt <text>', 'Custom prompt shown to the user')
  .option('--expires-in <minutes>', 'Minutes until expiry (default: 10080 = 7d)')
  .option('--json', 'Output as JSON')
  .action((titleParts: string[], opts) => run('Create', async () => {
    const body: Record<string, unknown> = { title: titleParts.join(' ') };
    if (opts.description) body.description = opts.description;
    if (opts.type) body.response_type = opts.type;
    if (opts.prompt) body.prompt = opts.prompt;
    if (opts.choices) body.choices = String(opts.choices).split(',').map((s: string) => s.trim()).filter(Boolean);
    if (opts.expiresIn) body.expires_in_minutes = Number(opts.expiresIn);

    const res = await post<{ data: { guid: string } }>('/approvals', body);
    printResult(success(`Created ${res.data.guid}.`), opts, res.data);
  }));

approvalCommand
  .command('answer <guid> [selection...]')
  .description('Answer an approval: a = approve, b = deny, c = ignore, or free text for text-type')
  .option('--json', 'Output as JSON')
  .action((guid: string, selectionParts: string[], opts) => run('Answer', async () => {
    if (!guid.startsWith('ap_')) {
      throw new Error('Expected approval guid like ap_xxxxxxxx');
    }
    const detailRes = await get<{ data: { response_type: string; choices: string[] | null } }>(`/approvals/${guid}`);
    const detail = detailRes.data;
    const first = selectionParts[0];

    if (detail.response_type === 'text') {
      const text = selectionParts.join(' ').trim();
      if (!text) throw new Error('Text approval requires a response. Usage: gipity approval answer <guid> <response>');
      await post(`/approvals/${guid}/resolve`, { status: 'approved', response: text });
      printResult(`Response sent: ${text}`, opts, { guid, status: 'approved' });
      return;
    }

    const idx = first ? keyToIndex(first) : -1;
    if (idx < 0) {
      throw new Error('Select an option: a = approve, b = deny, c = ignore (or for choice type, pick a letter matching your option).');
    }

    let status: 'approved' | 'denied';
    let response: string | undefined;

    if (detail.response_type === 'choice' && detail.choices?.length) {
      if (idx === detail.choices.length) {
        printResult('Ignored.', opts, { guid, ignored: true });
        return;
      }
      if (idx >= detail.choices.length) throw new Error('Choice out of range');
      status = 'approved';
      response = detail.choices[idx];
    } else {
      // yes_no
      if (idx === 2) {
        printResult('Ignored.', opts, { guid, ignored: true });
        return;
      }
      if (idx > 1) throw new Error('Use a (approve), b (deny), or c (ignore)');
      status = idx === 0 ? 'approved' : 'denied';
    }

    await post(`/approvals/${guid}/resolve`, { status, response });
    printResult(status === 'approved' ? `Approved${response ? `: ${response}` : ''}.` : 'Denied.', opts, { guid, status });
  }));

approvalCommand
  .command('cancel <guid>')
  .description('Cancel a pending approval (unblocks agent without a decision)')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Cancel', async () => {
    if (!guid.startsWith('ap_')) {
      throw new Error('Expected approval guid like ap_xxxxxxxx');
    }
    await post(`/approvals/${guid}/cancel`, {});
    printResult(success(`Cancelled ${guid}.`), opts, { guid, cancelled: true });
  }));

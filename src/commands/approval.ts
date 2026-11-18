import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { get, post, del, getBaseUrl } from '../api.js';
import { muted, success } from '../colors.js';
import { verifyApproval, type ApprovalForVerify } from '../approval-verify.js';
import { run, printList, printResult } from '../helpers/index.js';

interface ApprovalSummary {
  guid: string;
  kind?: 'link' | 'passkey';
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
  .description('Manage approvals');

approvalCommand
  .command('list')
  .description('List pending approvals')
  .addOption(new Option('--status <status>', 'Filter by status').choices(['pending', 'approved', 'denied', 'cancelled', 'expired', 'all']).default('pending'))
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const res = await get<{ data: ApprovalSummary[] }>(`/approvals?status=${encodeURIComponent(opts.status)}`);
    printList(res.data, opts, 'No approvals.', a =>
      `${a.guid}  ${a.title}  ${muted(`[${a.status}${a.kind === 'passkey' ? ', passkey' : ''}] ${timeAgo(a.created_at)}`)}`,
    );
  }));

approvalCommand
  .command('create <title...>')
  .description('Create a pending approval')
  .option('--description <text>', 'Detailed context')
  .addOption(new Option('--type <type>', 'Approval type').choices(['yes_no', 'choice', 'text']).default('yes_no'))
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
  .option('--deny', 'Resolve as denied; any trailing text is sent as feedback (e.g. requested edits)')
  .option('--json', 'Output as JSON')
  .action((guid: string, selectionParts: string[], opts) => run('Answer', async () => {
    if (!guid.startsWith('ap_')) {
      throw new Error('Expected approval guid like ap_xxxxxxxx');
    }

    // Deny with optional free-text feedback works for every response type -
    // it's how a workflow gate's revision loop gets the user's edits
    // ({{gate.action}} == rejected + {{gate.human_response}}).
    if (opts.deny) {
      const feedback = selectionParts.join(' ').trim();
      await post(`/approvals/${guid}/resolve`, { status: 'denied', response: feedback || undefined });
      printResult(`Denied${feedback ? `: ${feedback}` : '.'}`, opts, { guid, status: 'denied' });
      return;
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
  .description('Cancel a pending approval without a decision (anything waiting on it stops waiting)')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Cancel', async () => {
    if (!guid.startsWith('ap_')) {
      throw new Error('Expected approval guid like ap_xxxxxxxx');
    }
    await post(`/approvals/${guid}/cancel`, {});
    printResult(success(`Cancelled ${guid}.`), opts, { guid, cancelled: true });
  }));

interface PasskeyView extends ApprovalForVerify {
  summary: string;
  approver: string;
  resolvedAt: string | null;
  consumedAt: string | null;
}

interface ApprovalDetail {
  guid: string;
  kind: 'link' | 'passkey';
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  passkey: PasskeyView | null;
}

function requireGuid(guid: string): void {
  if (!guid.startsWith('ap_')) throw new Error('Expected approval guid like ap_xxxxxxxx');
}

approvalCommand
  .command('show <guid>')
  .description('Show one approval (for a passkey approval: status, payload hash, expiry and whether it carries a signed proof)')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Show', async () => {
    requireGuid(guid);
    const { data } = await get<{ data: ApprovalDetail }>(`/approvals/${guid}`);
    const lines = [`${data.guid}  ${data.title}`];
    if (data.description) lines.push(muted(data.description));
    if (data.passkey) {
      const p = data.passkey;
      lines.push(
        `Status:       ${p.status} (passkey)`,
        `Approver:     ${p.approver}`,
        `Payload hash: ${p.payloadHash}`,
        `Expires:      ${p.expiresAt}`,
        `Resolved:     ${p.resolvedAt ?? '-'}`,
        `Consumed:     ${p.consumedAt ?? '-'}`,
        `Proof:        ${p.proof ? `signed by passkey ${p.proof.credentialId}` : 'none'}`,
      );
    } else {
      lines.push(`Status: ${data.status}`);
    }
    printResult(lines.join('\n'), opts, data);
  }));

interface PasskeySummary { id: string; label: string | null; createdAt: string; lastUsedAt: string | null }

approvalCommand
  .command('passkeys')
  .description('List the passkeys you approve with (add them in the browser at the printed link)')
  .option('--remove <id>', 'Remove one of your passkeys by id')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Passkeys', async () => {
    if (opts.remove) {
      await del(`/approvals/passkeys/credentials/${encodeURIComponent(opts.remove)}`);
      printResult(success(`Removed ${opts.remove}.`), opts, { id: opts.remove, removed: true });
      return;
    }
    const { data } = await get<{ data: PasskeySummary[] }>('/approvals/passkeys/credentials');
    const manageUrl = `${getBaseUrl()}/approvals/passkeys`;
    if (opts.json) {
      console.log(JSON.stringify({ passkeys: data, manageUrl }));
      return;
    }
    console.log(data.length
      ? data.map(k => `${k.id}  ${k.label ?? 'Passkey'}  ${muted(`added ${k.createdAt.slice(0, 10)}${k.lastUsedAt ? `, last used ${k.lastUsedAt.slice(0, 10)}` : ''}`)}`).join('\n')
      : 'No passkeys yet.');
    console.log(muted(`Add or remove passkeys in the browser: ${manageUrl}`));
  }));

approvalCommand
  .command('verify <guid>')
  .description('Verify a passkey approval offline, as a device does: recompute the payload hash and challenge and check the passkey signature')
  .requiredOption('--payload <file>', 'JSON file with the exact payload the approval is for')
  .option('--key <file>', "The approver's public key (JWK JSON) pinned at enrollment; without it the proof's own key is used and the result says so")
  .option('--origin <url>', 'Relying-party origin the passkey signed for (default: the API base)')
  .option('--json', 'Output as JSON')
  .action((guid: string, opts) => run('Verify', async () => {
    requireGuid(guid);
    const payload = JSON.parse(readFileSync(opts.payload, 'utf8'));
    const pinnedJwk = opts.key ? JSON.parse(readFileSync(opts.key, 'utf8')) : undefined;
    const { data } = await get<{ data: ApprovalDetail }>(`/approvals/${guid}`);
    if (!data.passkey) throw new Error(`${guid} is not a passkey approval`);
    const expectedOrigin = new URL(opts.origin ?? getBaseUrl()).origin;
    const result = verifyApproval(data.passkey, { payload, pinnedJwk, expectedOrigin });
    if (opts.json) {
      console.log(JSON.stringify({ id: guid, status: data.passkey.status, ...result }));
    } else {
      for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.check}${c.detail ? muted(`  (${c.detail})`) : ''}`);
      if (!result.pinned) console.log(muted('Key not pinned: checked against the key in the proof. Pass --key with the approver key you pinned.'));
      if (result.ok && data.passkey.status !== 'approved') console.log(muted(`Signature is valid, but the approval is ${data.passkey.status}.`));
    }
    if (!result.ok) {
      // --json already printed the failing checks; exit non-zero without a second JSON line.
      if (opts.json) { process.exitCode = 1; return; }
      throw new Error('verification failed');
    }
  }));

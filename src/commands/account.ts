import { Command } from 'commander';
import { del, get, getAccountSlug, patch } from '../api.js';
import { bold, brand, dim, muted } from '../colors.js';
import { run } from '../helpers/index.js';
import { confirm } from '../utils.js';

export interface NsfwState {
  allow_nsfw_services: boolean;
  nsfw_attested_at: string | null;
  self_serve_open: boolean;
}

/** The terms a person accepts when turning NSFW services on. Plain language. */
export const NSFW_TERMS = [
  'Turning on NSFW services lets this account use adult (NSFW) image models.',
  '',
  'By turning it on you confirm that:',
  '  - you are 18 or older;',
  '  - nothing you make involves minors, ever;',
  '  - you will not make sexual images of real people;',
  '  - you will not make content showing sexual violence or non-consent;',
  '  - you are responsible for what your apps show and to whom.',
  '',
  'Prompts are checked for safety and kept for abuse review. Gipity may turn this off.',
  'While it is on, app payments (Stripe Connect) stop working for your apps.',
  'Buying credits and your plan are not affected.',
].join('\n');

function renderState(s: NsfwState): void {
  console.log(`NSFW services: ${s.allow_nsfw_services ? bold('on') : dim('off')}`);
  if (s.nsfw_attested_at) console.log(muted(`  Terms accepted: ${s.nsfw_attested_at.slice(0, 10)}`));
  if (s.allow_nsfw_services) console.log(muted('  App payments (Stripe Connect) are off while this is on.'));
  else if (!s.self_serve_open) console.log(muted('  Not open for self-serve yet.'));
}

export const accountCommand = new Command('account')
  .description('Account settings')
  .addHelpText('after', '\nAccount-level settings for your Gipity account, e.g. `gipity account nsfw status`, `gipity account passkeys`, `gipity account delete`.');

const nsfwCommand = accountCommand
  .command('nsfw')
  .description('Allow NSFW services (adult image models) for this account');

nsfwCommand
  .command('status', { isDefault: true })
  .description('Show whether NSFW services are on')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Account', async () => {
    const res = await get<{ data: NsfwState }>('/users/me/nsfw');
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    renderState(res.data);
  }));

nsfwCommand
  .command('on')
  .description('Turn NSFW services on (confirms you are 18+ and accept the adult-content terms)')
  .option('-y, --yes', 'Accept the terms without asking')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Account', async () => {
    if (!opts.json) console.log(`${NSFW_TERMS}\n`);
    const ok = await confirm(`Turn on ${brand('NSFW services')} and accept these terms?`, { default: 'no', skip: opts.yes === true });
    if (!ok) { console.log(muted('Left off.')); process.exit(1); }
    const res = await patch<{ data: NsfwState }>('/users/me/nsfw', { allow: true, attest: true });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    renderState(res.data);
  }));

nsfwCommand
  .command('off')
  .description('Turn NSFW services off (app payments work again)')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Account', async () => {
    const res = await patch<{ data: NsfwState }>('/users/me/nsfw', { allow: false });
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    renderState(res.data);
  }));

export interface SigninPasskeysState {
  requirePasskey: boolean;
  passkeys: Array<{ id: string; label: string | null; fingerprint: string; createdAt: string; lastUsedAt: string | null }>;
  manageUrl: string;
}

// Read-only on purpose: adding a passkey needs a browser (WebAuthn), and
// turning "require passkey" on or off is something only the signed-in owner
// does on the hosted page, never a token handed to an agent.
accountCommand
  .command('passkeys')
  .description('Show your sign-in passkeys and whether a passkey is required to sign in')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Account', async () => {
    const res = await get<{ data: SigninPasskeysState }>('/auth/passkeys/state');
    const s = res.data;
    if (opts.json) { console.log(JSON.stringify(s)); return; }
    console.log(`Require passkey to sign in: ${s.requirePasskey ? bold('on') : dim('off')}`);
    if (!s.passkeys.length) console.log(muted('  No sign-in passkeys. You sign in with an email code.'));
    for (const p of s.passkeys) {
      const used = p.lastUsedAt ? `last used ${p.lastUsedAt.slice(0, 10)}` : 'never used';
      console.log(`  ${p.label ?? 'Passkey'}  ${muted(`fingerprint ${p.fingerprint}, added ${p.createdAt.slice(0, 10)}, ${used}`)}`);
    }
    console.log(muted(`Add or remove passkeys and change the setting in a browser: ${s.manageUrl}`));
  }));

// Deleting the account is CLI-only: Monitor (a hosted page) can't, so no page
// can ever close an account. The account name must be typed back (or passed
// as --confirm), so neither a person nor an agent deletes it by accident. The
// server refuses an API token (GIPITY_TOKEN): this needs a `gipity login` session.
accountCommand
  .command('delete')
  .description('Delete your Gipity account and everything in it (cannot be undone)')
  .option('--confirm <account>', 'Your account name, to confirm without a prompt')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Account', async () => {
    const slug = await getAccountSlug();
    let typed: string | undefined = opts.confirm;
    if (typed === undefined) {
      if (!process.stdin.isTTY) throw new Error('Pass --confirm <your account name> to delete the account without a prompt.');
      console.log(`This deletes every project, file, database, function, workflow and secret on ${bold(slug)}. It cannot be undone.`);
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      typed = (await rl.question(`Type ${slug} to confirm: `)).trim();
      rl.close();
    }
    if (typed !== slug) throw new Error("The account name didn't match. Nothing was deleted.");
    await del('/users/me');
    if (opts.json) { console.log(JSON.stringify({ deleted: true, account: slug })); return; }
    console.log(`Deleted account ${bold(slug)}.`);
  }));

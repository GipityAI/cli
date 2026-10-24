import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { get, put, del } from '../api.js';
import { requireConfig, getProjectRoot } from '../config.js';
import { error as clrError, muted, success, warning, bold } from '../colors.js';
import { run, printResult } from '../helpers/index.js';

export type AuthMode = 'gipity' | 'app' | 'both';
const AUTH_MODES: AuthMode[] = ['gipity', 'app', 'both'];

type Provider = 'google' | 'apple' | 'discord';
const PROVIDERS: Provider[] = ['google', 'apple', 'discord'];
const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google', apple: 'Apple', discord: 'Discord' };

interface ProviderStatus {
  provider: Provider;
  credentials: 'shared' | 'own' | null;
  available: boolean;
  redirect_uri: string;
  note: string | null;
}

interface AuthStatus {
  auth_mode: AuthMode;
  unique_player_names: boolean;
  email_code: boolean;
  providers: ProviderStatus[];
  warnings: string[];
}

function fail(msg: string): never {
  console.error(clrError(msg));
  process.exit(1);
}

function credentialsLabel(p: ProviderStatus): string {
  if (p.credentials === 'own') return 'own';
  if (p.credentials === 'shared') return 'shared (Gipity)';
  return 'not set';
}

function formatStatus(s: AuthStatus): string {
  const lines = [
    `Sign-in: ${s.auth_mode}`,
    `Unique names: ${s.unique_player_names ? 'on' : 'off'}`,
    `Email codes: ${s.email_code ? 'on' : 'off'}`,
    '',
  ];
  const rows = s.providers.map(p => [PROVIDER_LABEL[p.provider] ?? p.provider, credentialsLabel(p), p.note ?? '']);
  const w0 = Math.max('Provider'.length, ...rows.map(r => r[0].length));
  const w1 = Math.max('Credentials'.length, ...rows.map(r => r[1].length));
  lines.push(bold(`${'Provider'.padEnd(w0)}  ${'Credentials'.padEnd(w1)}  Note`));
  for (const r of rows) lines.push(`${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${muted(r[2])}`.trimEnd());
  for (const w of s.warnings) lines.push('', warning(w));
  lines.push('', muted('Set up a provider: gipity project auth provider <google|apple|discord>'));
  return lines.join('\n');
}

const SETUP_STEPS: Record<Provider, (redirect: string) => string[]> = {
  google: r => [
    'Google Cloud console > APIs & Services > Credentials > Create credentials > OAuth client ID.',
    'Application type: Web application.',
    `Under "Authorized redirect URIs" add: ${r}`,
    'Copy the client ID and client secret.',
    'APIs & Services > OAuth consent screen: set your app name and logo (this is what users see).',
    'The basic scopes (openid email profile) need no Google verification.',
    'gipity project auth provider google --client-id <id> --client-secret <secret>',
  ],
  apple: r => [
    'Apple Developer > Certificates, Identifiers & Profiles > Identifiers > add a Services ID.',
    '  Its identifier is your client ID.',
    `Enable Sign in with Apple on it, register your domain and the return URL: ${r}`,
    'Keys > add a key with Sign in with Apple enabled. Note its Key ID and download the .p8 file (only once).',
    'Your Team ID is on the Membership details page.',
    'gipity project auth provider apple --client-id <services-id> --team-id <team> --key-id <key> --private-key-file AuthKey_XXXX.p8',
  ],
  discord: r => [
    'Discord Developer Portal > Applications > your application > OAuth2.',
    `Add the redirect: ${r}`,
    'Copy the client ID and reset/copy the client secret.',
    'gipity project auth provider discord --client-id <id> --client-secret <secret>',
  ],
};

function formatProvider(p: ProviderStatus): string {
  const name = PROVIDER_LABEL[p.provider];
  const lines = [
    `${bold(name)}: ${credentialsLabel(p)}${p.available ? '' : muted(' (off)')}`,
  ];
  if (p.note) lines.push(muted(p.note));
  lines.push('', `Redirect URI: ${p.redirect_uri}`, '', 'Use your own credentials:');
  let n = 0;
  for (const step of SETUP_STEPS[p.provider](p.redirect_uri)) {
    lines.push(step.startsWith('  ') ? `   ${step.trim()}` : `${++n}. ${step}`);
  }
  if (p.provider === 'google') {
    lines.push('', muted('Switching Google from shared to your own credentials keeps every existing user (a Google account has the same id under any client).'));
  }
  if (p.provider !== 'apple' && p.credentials === 'own') {
    lines.push('', muted(`Back to Gipity's shared credentials: gipity project auth provider ${p.provider} --shared`));
  }
  return lines.join('\n');
}

export function registerAuthCommand(projectCommand: Command): void {
  const auth = projectCommand
    .command('auth [mode]')
    .description('Show or set who can sign in to the deployed app: gipity, app (its own users), or both')
    // Options after `provider` belong to it (`auth provider google --json`).
    .enablePositionalOptions()
    .addHelpText('after', `
Modes:
  gipity  Sign in with Gipity only (default)
  app     Users sign in to this app alone, without a Gipity account:
          Google, Apple, Discord and email codes for web apps (the hosted sign-in
          page / Gipity.auth.signIn), Steam (POST /api/<guid>/auth/steam) and guest
          devices (POST /api/<guid>/auth/guest) for games
  both    Either

Sign-in providers:
  gipity project auth provider <google|apple|discord>   show setup steps and the redirect URI
  Google and Discord work at once on Gipity's shared credentials; Apple needs your own.
  Manage the app's users: gipity project users

--unique-names on|off
  On: no two players of this app can have the same display name (case and
  lookalike letters ignored). A taken name is refused with DISPLAY_NAME_TAKEN;
  GET /api/<guid>/auth/player/name-available?name=... checks one and suggests
  free alternatives. Players who already share a name keep it, and sign in with
  nameConflict: true until they rename. Off by default.

Steam also needs the Steamworks publisher key and AppID:
  gipity secrets set STEAM_WEB_API_KEY <key>
  gipity secrets set STEAM_APP_ID <appid>
See: gipity skill read steam-game`)
    .option('--unique-names <on|off>', 'Require unique player display names in this app')
    .option('--json', 'Output as JSON')
    .action((mode: string | undefined, opts) => run('Auth', async () => {
      const config = requireConfig();
      const body: { auth_mode?: AuthMode; unique_player_names?: boolean } = {};
      if (mode !== undefined) {
        if (!AUTH_MODES.includes(mode as AuthMode)) {
          fail(`Unknown mode "${mode}". Use one of: ${AUTH_MODES.join(', ')} (or: provider <name>).`);
        }
        body.auth_mode = mode as AuthMode;
      }
      if (opts.uniqueNames !== undefined) {
        if (opts.uniqueNames !== 'on' && opts.uniqueNames !== 'off') {
          fail(`--unique-names takes "on" or "off", not "${opts.uniqueNames}".`);
        }
        body.unique_player_names = opts.uniqueNames === 'on';
      }
      if (Object.keys(body).length === 0) {
        const res = await get<{ data: AuthStatus }>(`/projects/${config.projectGuid}/auth`);
        printResult(formatStatus(res.data), opts, res.data);
        return;
      }
      const res = await put<{ data: { success: boolean; players_sharing_names?: number } }>(`/projects/${config.projectGuid}`, body);
      const lines: string[] = [];
      if (body.auth_mode) {
        lines.push(success(`Sign-in set to "${body.auth_mode}".`));
        // gipity.yaml is the source of truth (deploys apply it), so keep it in step.
        const root = getProjectRoot();
        if (root && writeYamlAuthMode(join(root, 'gipity.yaml'), body.auth_mode)) {
          lines.push(muted('gipity.yaml: auth.mode updated (deploys apply it).'));
        }
      }
      if (body.unique_player_names !== undefined) {
        lines.push(success(`Unique names ${body.unique_player_names ? 'on' : 'off'}.`));
        const sharing = res.data.players_sharing_names ?? 0;
        if (sharing > 0) {
          lines.push(muted(`${sharing} existing player${sharing === 1 ? '' : 's'} share${sharing === 1 ? 's' : ''} a name with an earlier player. They keep it, and sign in with nameConflict: true until they rename.`));
        }
      }
      printResult(lines.join('\n'), opts, { ...body, ...(res.data.players_sharing_names !== undefined ? { players_sharing_names: res.data.players_sharing_names } : {}) });
    }));

  auth
    .command('provider <name>')
    .description('Show setup for a sign-in provider (google, apple, discord), set your own credentials, or go back to shared')
    .option('--client-id <id>', 'OAuth client ID (Apple: the Services ID)')
    .option('--client-secret <secret>', 'OAuth client secret (Google, Discord)')
    .option('--team-id <id>', 'Apple Team ID')
    .option('--key-id <id>', 'Apple Sign in with Apple key ID')
    .option('--private-key-file <path>', 'Apple .p8 private key file')
    .option('--shared', "Remove your own credentials and use Gipity's shared ones")
    .option('--json', 'Output as JSON')
    .action((name: string, opts) => run('Provider', async () => {
      const provider = name.toLowerCase() as Provider;
      if (!PROVIDERS.includes(provider)) fail(`Unknown provider "${name}". Use one of: ${PROVIDERS.join(', ')}.`);
      const config = requireConfig();
      const base = `/projects/${config.projectGuid}/auth/providers/${provider}`;
      const label = PROVIDER_LABEL[provider];
      const credFlags = ['clientId', 'clientSecret', 'teamId', 'keyId', 'privateKeyFile'].filter(k => opts[k] !== undefined);

      if (opts.shared) {
        if (credFlags.length) fail('--shared cannot be combined with credential flags.');
        const res = await del<{ data: { provider: Provider; credentials: 'shared' | null } }>(base);
        const msg = res.data.credentials === 'shared'
          ? success(`${label} sign-in now uses Gipity's shared credentials.`)
          : success(`Removed your ${label} credentials.`) + '\n' + muted(`${label} sign-in is off until you set your own credentials.`);
        printResult(msg, opts, res.data);
        return;
      }

      if (credFlags.length === 0) {
        const res = await get<{ data: AuthStatus }>(`/projects/${config.projectGuid}/auth`);
        const p = res.data.providers.find(x => x.provider === provider);
        if (!p) fail(`${label} sign-in is not available.`);
        printResult(formatProvider(p), opts, p);
        return;
      }

      let body: Record<string, string>;
      if (provider === 'apple') {
        const missing = [['clientId', '--client-id'], ['teamId', '--team-id'], ['keyId', '--key-id'], ['privateKeyFile', '--private-key-file']]
          .filter(([k]) => !opts[k]).map(([, f]) => f);
        if (missing.length) fail(`Apple needs ${missing.join(', ')}. See: gipity project auth provider apple`);
        if (opts.clientSecret) fail('Apple takes --team-id, --key-id and --private-key-file, not --client-secret.');
        let privateKey: string;
        try {
          privateKey = readFileSync(opts.privateKeyFile, 'utf-8');
        } catch (err: any) {
          fail(`Cannot read ${opts.privateKeyFile}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
        }
        if (!privateKey.includes('PRIVATE KEY')) fail(`${opts.privateKeyFile} does not look like a .p8 private key.`);
        body = { client_id: opts.clientId, team_id: opts.teamId, key_id: opts.keyId, private_key: privateKey };
      } else {
        const missing = [['clientId', '--client-id'], ['clientSecret', '--client-secret']]
          .filter(([k]) => !opts[k]).map(([, f]) => f);
        if (missing.length) fail(`${label} needs ${missing.join(' and ')}. See: gipity project auth provider ${provider}`);
        const extra = ['teamId', 'keyId', 'privateKeyFile'].filter(k => opts[k] !== undefined);
        if (extra.length) fail(`--team-id, --key-id and --private-key-file are for Apple only.`);
        body = { client_id: opts.clientId, client_secret: opts.clientSecret };
      }
      const res = await put<{ data: { provider: Provider; credentials: 'own' } }>(base, body);
      const lines = [success(`${label} sign-in now uses your own credentials.`)];
      if (provider === 'google') lines.push(muted('Existing Google users keep their accounts.'));
      printResult(lines.join('\n'), opts, res.data);
    }));
}

/** Write `auth: { mode }` into gipity.yaml, the app's source of truth for its
 *  sign-in mode (every deploy applies it). A text edit, so comments survive:
 *  replace an existing top-level `auth:` block, or append one. Returns false
 *  when the project has no gipity.yaml. Exported for tests. */
export function writeYamlAuthMode(yamlPath: string, mode: string): boolean {
  if (!existsSync(yamlPath)) return false;
  const text = readFileSync(yamlPath, 'utf-8');
  const block = `auth:\n  mode: ${mode}\n`;
  const existing = /^auth:[^\n]*\n(?:[ \t]+[^\n]*\n|[ \t]*\n)*/m;
  const next = existing.test(text)
    ? text.replace(existing, block)
    : `${text.replace(/\n*$/, '\n')}\n# Who signs in to the app: gipity | app (its own users, incl. guests) | both\n${block}`;
  writeFileSync(yamlPath, next);
  return true;
}

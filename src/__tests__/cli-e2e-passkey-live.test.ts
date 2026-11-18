// Real platform e2e: `gipity login` on an account that requires a passkey.
// The CLI must not take an email code alone: it prints a sign-in link and
// polls. The test plays the person in the browser, finishing the passkey step
// through the same API the hosted page uses, with a software authenticator
// (genuine WebAuthn bytes, verified by the server). Skipped unless GIPITY_E2E=1.
//
// Uses a throwaway `ec-` account (turning "require passkey" on would break the
// shared e2e account), deleted at the end. Dev-bypass auth (magic code 914914).
//
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { CLI_ENTRY, makeTmpHome } from './helpers/spawn-cli.js';
import { SoftPasskey } from './helpers/soft-passkey.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';
const EMAIL = `ec-cli-e2e-passkey-${Date.now().toString(36)}@914-6.com`;
const ORIGIN = new URL(API_BASE).origin;

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') ?? '' };
}

describe('cli-e2e-passkey-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  let accessToken = '';
  let cookie = '';
  let key: SoftPasskey;

  before(async () => {
    assert.equal((await call('/auth/login', { method: 'POST', body: { email: EMAIL } })).status, 200);
    const verify = await call('/auth/verify', { method: 'POST', body: { email: EMAIL, code: CODE } });
    assert.equal(verify.status, 200, verify.text);
    accessToken = verify.json.accessToken;
    const sid = /gipity_sid=([^;]+)/.exec(verify.setCookie)?.[1];
    assert.ok(sid, 'no session cookie from /auth/verify');
    cookie = `gipity_sid=${sid}`;

    // Add a sign-in passkey and require it, as the owner would on the settings page.
    const opts = await call('/auth/passkeys/register/options', { method: 'POST', body: {}, headers: { Cookie: cookie } });
    assert.equal(opts.status, 200, `this server has no passkey sign-in: ${opts.status} ${opts.text}`);
    const rpId: string = opts.json.data.rp.id;
    key = new SoftPasskey(rpId, new URL(API_BASE).hostname === rpId ? ORIGIN : `https://${rpId}`);
    const reg = await call('/auth/passkeys/register/verify', {
      method: 'POST', headers: { Cookie: cookie }, body: { label: 'cli e2e', response: key.registrationResponse(opts.json.data) },
    });
    assert.equal(reg.status, 201, reg.text);
    const on = await call('/auth/passkeys/require', { method: 'POST', headers: { Cookie: cookie }, body: { on: true } });
    assert.equal(on.status, 200, on.text);
  });

  after(async () => {
    if (accessToken) await call('/users/me', { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('gipity login prints the passkey link, waits, and signs in once the step is done', async () => {
    const child = spawn(process.execPath, [CLI_ENTRY, '--api-base', API_BASE, 'login', '--email', EMAIL, '--code', CODE, '--json'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: tmpHome, NO_COLOR: '1', CI: '1', DISABLE_AUTOUPDATER: '1', GIPITY_NO_BROWSER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);

    // Wait for the sign-in link, then finish the step as the browser page would.
    const url = await new Promise<string>((resolve, reject) => {
      child.stderr.on('data', (c) => {
        stderr += c;
        const m = /(https?:\/\/\S+\/auth\/passkey\?step=[A-Za-z0-9_-]+)/.exec(stderr);
        if (m) resolve(m[1]);
      });
      child.on('exit', () => reject(new Error(`CLI exited before printing a link:\n${stdout}\n${stderr}`)));
    });
    assert.equal(existsSync(join(tmpHome, '.gipity', 'auth.json')), false, 'no session before the passkey step');
    const step = new URL(url).searchParams.get('step')!;
    const options = await call('/auth/passkey/options', { method: 'POST', body: { step } });
    assert.equal(options.status, 200, options.text);
    const done = await call('/auth/passkey/verify', {
      method: 'POST', body: { ceremony: options.json.data.ceremony, step, response: key.assertionResponse(options.json.data.options.challenge) },
    });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.json.data, { cli: true });

    const status = await exited;
    clearTimeout(timer);
    assert.equal(status, 0, `login failed:\n${stdout}\n${stderr}`);
    const out = JSON.parse(stdout);
    assert.equal(out.loggedIn, true);
    assert.equal(out.passkey, true);
    const auth = JSON.parse(readFileSync(join(tmpHome, '.gipity', 'auth.json'), 'utf-8'));
    assert.equal(auth.email, EMAIL);

    // The CLI's new session works.
    const me = await call('/auth/passkeys/state', { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.data.requirePasskey, true);
  });
});

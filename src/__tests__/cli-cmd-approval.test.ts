import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, tempDir } from './helpers/test-home.js';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { payloadHash, summaryHash, approvalChallenge } from '../approval-verify.js';
import { SERVER_PROOF_FIXTURE } from './fixtures/approval-proof.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function run(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

test('gipity approval list shows pending approvals with status', async () => {
  mock.reset();
  mock.on('GET /approvals', { body: { data: [
    { guid: 'ap_Approv001', title: 'Deploy to prod?', status: 'pending', response_type: 'yes_no', choices: null, created_at: new Date(Date.now() - 5 * 60_000).toISOString() },
  ] } });
  const r = await run(['approval', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ap_Approv001/);
  assert.match(r.stdout, /Deploy to prod\?/);
  assert.match(r.stdout, /pending/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity approval create POSTs and prints created guid', async () => {
  mock.reset();
  mock.on('POST /approvals', { status: 201, body: { data: { guid: 'ap_NewApprov0' } } });
  const r = await run(['approval', 'create', 'Test', 'approval']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created ap_NewApprov0/);
});

test('gipity approval answer a (approve) resolves a yes_no approval', async () => {
  mock.reset();
  mock.on('GET /approvals/ap_Approv001', { body: { data: { response_type: 'yes_no', choices: null } } });
  mock.on('POST /approvals/ap_Approv001/resolve', { body: { data: { resolved: true } } });
  const r = await run(['approval', 'answer', 'ap_Approv001', 'a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Approved/);
});

test('gipity approval answer --deny sends denied with free-text feedback', async () => {
  mock.reset();
  let resolveBody: Record<string, unknown> | undefined;
  mock.on('POST /approvals/ap_Approv001/resolve', (req) => {
    resolveBody = req.body as Record<string, unknown>;
    return { body: { data: { resolved: true } } };
  });
  const r = await run(['approval', 'answer', 'ap_Approv001', '--deny', 'try', 'again,', 'friendlier', 'tone']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Denied: try again, friendlier tone/);
  assert.deepEqual(resolveBody, { status: 'denied', response: 'try again, friendlier tone' });
});

test('gipity approval cancel <guid> POSTs cancel + prints cancelled', async () => {
  mock.reset();
  mock.on('POST /approvals/ap_Approv001/cancel', { body: { data: { cancelled: true } } });
  const r = await run(['approval', 'cancel', 'ap_Approv001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Cancelled ap_Approv001/);
});

/** A passkey approval signed by a fresh software P-256 authenticator for the
 *  mock server's own origin (the CLI's default expected origin). */
function signedApproval(payload: unknown) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const origin = new URL(mock.apiBase).origin;
  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
  const id = 'ap_Signed001';
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 300_000).toISOString();
  const hash = payloadHash(payload);
  const challenge = approvalChallenge(id, hash, summaryHash('Open valve', null), expiresAt);
  const ad = Buffer.concat([sha(new URL(origin).hostname), Buffer.from([0x05]), Buffer.from([0, 0, 0, 7])]);
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
  const signature = sign('sha256', Buffer.concat([ad, sha(cd)]), privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    jwk,
    detail: {
      guid: id, kind: 'passkey', title: 'Open valve', description: null, status: 'approved', created_at: new Date().toISOString(), resolved_at: null,
      passkey: {
        id, status: 'approved', summary: 'Open valve', details: null, payloadHash: hash, expiresAt, approver: 'u_Approver1',
        resolvedAt: new Date().toISOString(), consumedAt: null,
        proof: {
          credentialId: 'cred1', publicKeyJwk: { ...jwk, alg: 'ES256' }, authenticatorData: ad.toString('base64url'),
          clientDataJSON: cd.toString('base64url'), signature: signature.toString('base64url'),
          rpId: new URL(origin).hostname, origin, challenge,
        },
      },
    },
  };
}

test('gipity approval show prints a passkey approval with its hash, expiry and proof', async () => {
  mock.reset();
  const { detail } = signedApproval({ valve: 3 });
  mock.on('GET /approvals/ap_Signed001', { body: { data: detail } });
  const r = await run(['approval', 'show', 'ap_Signed001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /approved \(passkey\)/);
  assert.match(r.stdout, new RegExp(detail.passkey.payloadHash));
  assert.match(r.stdout, /signed by passkey cred1/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity approval verify passes for a valid proof with the pinned key', async () => {
  mock.reset();
  const payload = { valve: 3, open: true };
  const { detail, jwk } = signedApproval(payload);
  mock.on('GET /approvals/ap_Signed001', { body: { data: detail } });
  const dir = tempDir('approval-verify-');
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ open: true, valve: 3 }));
  writeFileSync(join(dir, 'key.json'), JSON.stringify(jwk));
  const r = await run(['approval', 'verify', 'ap_Signed001', '--payload', join(dir, 'payload.json'), '--key', join(dir, 'key.json'), '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.ok, true);
  assert.equal(out.pinned, true);
});

test('gipity approval verify fails (exit 1) when the payload differs', async () => {
  mock.reset();
  const { detail, jwk } = signedApproval({ valve: 3 });
  mock.on('GET /approvals/ap_Signed001', { body: { data: detail } });
  const dir = tempDir('approval-verify-');
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ valve: 4 }));
  writeFileSync(join(dir, 'key.json'), JSON.stringify(jwk));
  const r = await run(['approval', 'verify', 'ap_Signed001', '--payload', join(dir, 'payload.json'), '--key', join(dir, 'key.json')]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}payload hash matches/);
});

test('gipity approval verify checks a platform-produced proof against https://a.gipity.ai (expired by now)', async () => {
  mock.reset();
  const fx = SERVER_PROOF_FIXTURE;
  mock.on('GET /approvals/' + fx.approval.id, { body: { data: {
    guid: fx.approval.id, kind: 'passkey', title: fx.approval.summary, description: null, status: 'approved',
    created_at: fx.approval.resolvedAt, resolved_at: fx.approval.resolvedAt, passkey: fx.approval,
  } } });
  const dir = tempDir('approval-verify-');
  writeFileSync(join(dir, 'payload.json'), JSON.stringify(fx.payload));
  writeFileSync(join(dir, 'key.json'), JSON.stringify(fx.pinnedJwk));
  const r = await run(['approval', 'verify', fx.approval.id, '--payload', join(dir, 'payload.json'), '--key', join(dir, 'key.json'),
    '--origin', 'https://a.gipity.ai', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  // Every cryptographic check passes; only the (long past) expiry fails.
  assert.deepEqual(out.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check), ['not expired']);
});

test('gipity approval passkeys lists passkeys and prints where to manage them', async () => {
  mock.reset();
  mock.on('GET /approvals/passkeys/credentials', { body: { data: [
    { id: 'pk_Phone0001', label: 'My phone', fingerprint: 'feed 9234 487a e4fe', createdAt: '2026-11-01T10:00:00.000Z', lastUsedAt: null },
  ] } });
  const r = await run(['approval', 'passkeys']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pk_Phone0001 {2}My phone {2}feed 9234 487a e4fe/);
  assert.match(r.stdout, /\/approvals\/passkeys/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity approval passkeys --remove deletes one', async () => {
  mock.reset();
  mock.on('DELETE /approvals/passkeys/credentials/pk_Phone0001', { body: { data: { removed: true } } });
  const r = await run(['approval', 'passkeys', '--remove', 'pk_Phone0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed pk_Phone0001/);
});

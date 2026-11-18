import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyApproval, canonicalJson, payloadHash, approvalChallenge, type ApprovalForVerify } from '../approval-verify.js';
import { SERVER_PROOF_FIXTURE } from './fixtures/approval-proof.js';

const fx = SERVER_PROOF_FIXTURE;
const ORIGIN = 'https://a.gipity.ai';
const beforeExpiry = Date.parse(fx.approval.expiresAt) - 60_000;
const approval = fx.approval as unknown as ApprovalForVerify;

const failed = (r: { checks: { check: string; ok: boolean }[] }) => r.checks.filter(c => !c.ok).map(c => c.check);

test('a proof produced by the platform verifies offline with the pinned key', () => {
  const r = verifyApproval(approval, { payload: fx.payload, pinnedJwk: fx.pinnedJwk, expectedOrigin: ORIGIN, now: beforeExpiry });
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.pinned, true);
});

test('canonical JSON and payload hash match the platform', () => {
  assert.equal(canonicalJson({ unit: 'C', cmd: 'set', target: 65 }), '{"cmd":"set","target":65,"unit":"C"}');
  assert.equal(payloadHash(fx.payload), fx.approval.payloadHash);
  assert.equal(payloadHash({ target: 65, unit: 'C', cmd: 'set' }), fx.approval.payloadHash);
  assert.equal(approvalChallenge(fx.approval.id, fx.approval.payloadHash, fx.approval.expiresAt), fx.approval.proof.challenge);
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
});

test('a different payload fails the hash and challenge checks', () => {
  const r = verifyApproval(approval, { payload: { ...fx.payload, target: 90 }, pinnedJwk: fx.pinnedJwk, expectedOrigin: ORIGIN, now: beforeExpiry });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ['payload hash matches', 'clientData challenge matches']);
});

test('a key other than the pinned one fails', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const r = verifyApproval(approval, { payload: fx.payload, pinnedJwk: other, expectedOrigin: ORIGIN, now: beforeExpiry });
  assert.deepEqual(failed(r), ['proof key is the pinned key', 'signature verifies']);
});

test('an expired approval fails, and so does the wrong origin', () => {
  const late = verifyApproval(approval, { payload: fx.payload, pinnedJwk: fx.pinnedJwk, expectedOrigin: ORIGIN, now: Date.parse(fx.approval.expiresAt) });
  assert.deepEqual(failed(late), ['not expired']);
  const elsewhere = verifyApproval(approval, { payload: fx.payload, pinnedJwk: fx.pinnedJwk, expectedOrigin: 'https://app.gipity.ai', now: beforeExpiry });
  assert.deepEqual(failed(elsewhere), ['clientData origin matches', 'rpIdHash matches']);
});

test('a forged signature or tampered authenticator flags fail', () => {
  const p = fx.approval.proof;
  const badSig = { ...approval, proof: { ...p, signature: Buffer.from(p.signature, 'base64url').reverse().toString('base64url') } } as ApprovalForVerify;
  assert.deepEqual(failed(verifyApproval(badSig, { payload: fx.payload, pinnedJwk: fx.pinnedJwk, expectedOrigin: ORIGIN, now: beforeExpiry })), ['signature verifies']);
  const ad = Buffer.from(p.authenticatorData, 'base64url');
  ad[32] = ad[32] & ~0x04; // clear UV
  const noUv = { ...approval, proof: { ...p, authenticatorData: ad.toString('base64url') } } as ApprovalForVerify;
  assert.deepEqual(failed(verifyApproval(noUv, { payload: fx.payload, pinnedJwk: fx.pinnedJwk, expectedOrigin: ORIGIN, now: beforeExpiry })),
    ['user verified (UV)', 'signature verifies']);
});

test('an approval without a proof (pending, denied) never verifies', () => {
  const r = verifyApproval({ ...approval, status: 'pending', proof: null }, { payload: fx.payload, expectedOrigin: ORIGIN });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ['proof present']);
});

test('without a pinned key the proof key is used and the result says pinned: false', () => {
  const r = verifyApproval(approval, { payload: fx.payload, expectedOrigin: ORIGIN, now: beforeExpiry });
  assert.equal(r.ok, true);
  assert.equal(r.pinned, false);
});

test('an Ed25519 passkey verifies too', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
  const id = 'ap_ed25519x';
  const expiresAt = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const hash = payloadHash({ a: 1 });
  const ad = Buffer.concat([sha('a.gipity.ai'), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: approvalChallenge(id, hash, expiresAt), origin: ORIGIN }));
  const signature = sign(null, Buffer.concat([ad, sha(cd)]), privateKey);
  const r = verifyApproval({
    id, status: 'approved', payloadHash: hash, expiresAt,
    proof: { credentialId: 'x', publicKeyJwk: jwk, authenticatorData: ad.toString('base64url'), clientDataJSON: cd.toString('base64url'),
      signature: signature.toString('base64url'), rpId: 'a.gipity.ai', origin: ORIGIN, challenge: '' },
  }, { payload: { a: 1 }, pinnedJwk: jwk, expectedOrigin: ORIGIN });
  assert.deepEqual(failed(r), []);
});

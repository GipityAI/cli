/**
 * Offline verification of a Gipity passkey approval: exactly the checks a
 * device outside Gipity makes before it runs an approved action. Nothing here
 * trusts the server: the payload hash and challenge are recomputed locally and
 * the signature is checked against a key the caller pinned at enrollment.
 *
 * Rules (the app-approvals skill documents the same):
 *   payloadHash = hex sha256 of the canonical JSON of the payload (RFC 8785:
 *                 keys sorted, no whitespace, JSON.stringify scalars)
 *   challenge   = sha256("gipity-approval:v1|" + id + "|" + payloadHash + "|" + expiresAt)
 *   clientDataJSON.type == "webauthn.get", .challenge == base64url(challenge), .origin == expected origin
 *   authenticatorData: rpIdHash == sha256(rpId), flags UP (0x01) and UV (0x04) set
 *   signature over authenticatorData || sha256(clientDataJSON), verified with the pinned key
 *   expiresAt in the future
 */
import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface ApprovalProof {
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  rpId: string;
  origin: string;
  challenge: string;
}

export interface ApprovalForVerify {
  id: string;
  status: string;
  payloadHash: string;
  expiresAt: string;
  proof: ApprovalProof | null;
}

export interface VerifyOptions {
  payload: unknown;
  /** The approver's public key, pinned out of band. Without it the proof's
   *  own key is used and the result says `pinned: false`. */
  pinnedJwk?: JsonWebKey;
  /** The relying-party origin, e.g. https://a.gipity.ai. */
  expectedOrigin: string;
  now?: number;
}

export interface VerifyCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  pinned: boolean;
  checks: VerifyCheck[];
}

const CHALLENGE_PREFIX = 'gipity-approval:v1|';

/** RFC 8785 canonical JSON. Throws on values JSON can't represent exactly. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('payload contains a non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const obj = value as Record<string, unknown>;
      return `{${Object.keys(obj).sort().map((k) => {
        if (obj[k] === undefined) throw new Error(`payload field '${k}' is undefined`);
        return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
      }).join(',')}}`;
    }
    default:
      throw new Error(`payload contains a value JSON can't represent (${typeof value})`);
  }
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

export function payloadHash(payload: unknown): string {
  return sha256(canonicalJson(payload)).toString('hex');
}

export function approvalChallenge(id: string, hash: string, expiresAt: string): string {
  return sha256(`${CHALLENGE_PREFIX}${id}|${hash}|${expiresAt}`).toString('base64url');
}

function sameKey(a: JsonWebKey, b: JsonWebKey): boolean {
  if (a.kty !== b.kty) return false;
  if (a.kty === 'EC') return a.crv === b.crv && a.x === b.x && a.y === b.y;
  if (a.kty === 'OKP') return a.crv === b.crv && a.x === b.x;
  if (a.kty === 'RSA') return a.n === b.n && a.e === b.e;
  return false;
}

function verifySignature(jwk: JsonWebKey, data: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, n: jwk.n, e: jwk.e } as JsonWebKey, format: 'jwk' });
  // ES256 and RS256 hash with SHA-256 (ECDSA signatures are DER, as WebAuthn
  // sends them); Ed25519 signs the message itself.
  return verify(jwk.kty === 'OKP' ? null : 'sha256', data, key, signature);
}

export function verifyApproval(approval: ApprovalForVerify, opts: VerifyOptions): VerifyResult {
  const checks: VerifyCheck[] = [];
  const add = (check: string, ok: boolean, detail?: string) => checks.push(detail ? { check, ok, detail } : { check, ok });
  const proof = approval.proof;
  if (!proof) {
    add('proof present', false, `approval is ${approval.status}; there is no passkey proof`);
    return { ok: false, pinned: !!opts.pinnedJwk, checks };
  }

  const expectedRpId = new URL(opts.expectedOrigin).hostname;
  const hash = payloadHash(opts.payload);
  add('payload hash matches', hash === approval.payloadHash, hash === approval.payloadHash ? undefined : `local ${hash}`);

  const challenge = approvalChallenge(approval.id, hash, approval.expiresAt);
  let clientData: { type?: string; challenge?: string; origin?: string } = {};
  const clientDataBytes = Buffer.from(proof.clientDataJSON, 'base64url');
  try {
    clientData = JSON.parse(clientDataBytes.toString('utf8'));
  } catch {
    add('clientDataJSON parses', false);
  }
  add('clientData type is webauthn.get', clientData.type === 'webauthn.get');
  add('clientData challenge matches', clientData.challenge === challenge);
  add('clientData origin matches', clientData.origin === opts.expectedOrigin,
    clientData.origin === opts.expectedOrigin ? undefined : `got ${String(clientData.origin)}`);

  const authData = Buffer.from(proof.authenticatorData, 'base64url');
  const rpIdOk = authData.length >= 37 && authData.subarray(0, 32).equals(sha256(expectedRpId));
  add('rpIdHash matches', rpIdOk);
  const flags = authData.length >= 37 ? authData[32] : 0;
  add('user present (UP)', (flags & 0x01) !== 0);
  add('user verified (UV)', (flags & 0x04) !== 0);

  const key = opts.pinnedJwk ?? proof.publicKeyJwk;
  if (opts.pinnedJwk) add('proof key is the pinned key', sameKey(opts.pinnedJwk, proof.publicKeyJwk));
  let sigOk = false;
  try {
    sigOk = verifySignature(key, Buffer.concat([authData, sha256(clientDataBytes)]), Buffer.from(proof.signature, 'base64url'));
  } catch {
    sigOk = false;
  }
  add('signature verifies', sigOk);

  const expiresMs = Date.parse(approval.expiresAt);
  const notExpired = Number.isFinite(expiresMs) && expiresMs > (opts.now ?? Date.now());
  add('not expired', notExpired, notExpired ? undefined : `expired at ${approval.expiresAt}`);

  return { ok: checks.every((c) => c.ok), pinned: !!opts.pinnedJwk, checks };
}

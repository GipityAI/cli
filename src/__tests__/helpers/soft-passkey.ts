/**
 * A software WebAuthn authenticator for CLI live tests: a real P-256 key that
 * produces genuine registration (attestation 'none') and assertion responses,
 * which the server verifies exactly as it would a phone's. It stands in for the
 * person finishing a passkey step in the browser. Nothing is faked on the
 * server side. (Same idea as the platform's soft-authenticator.ts; the CLI repo
 * has no CBOR dependency, so the few CBOR shapes needed are encoded here.)
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/** Minimal CBOR: unsigned/negative ints, byte strings, text strings, maps. */
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error('CBOR length too large for this encoder');
}
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

export class SoftPasskey {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  counter = 0;

  constructor(readonly rpId: string, readonly origin: string) {
    ({ privateKey: this.privateKey, publicKey: this.publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }));
  }

  get id(): string { return b64u(this.credentialId); }

  registrationResponse(options: { challenge: string }) {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const coseKey = cbor(new Map<Cbor, Cbor>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
    ]));
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([0x01 | 0x04 | 0x40]), Buffer.alloc(4), Buffer.alloc(16),
      Buffer.from([0, this.credentialId.length]), this.credentialId, coseKey,
    ]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false });
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { attestationObject: b64u(attestationObject), clientDataJSON: b64u(Buffer.from(clientDataJSON)), transports: ['internal'] },
    };
  }

  assertionResponse(challenge: string) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x01 | 0x04]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: this.origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) },
    };
  }
}

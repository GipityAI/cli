/**
 * Secret redaction for relay capture entries.
 *
 * The relay daemon spawns Claude Code with `--permission-mode
 * bypassPermissions`, so a dispatched session can read any file or env var
 * on the relay host - including the shared Claude credential the host runs
 * on. On a hosted relay (shared-credential test setup) a `cat`/`env` in a
 * dispatched session would otherwise land the credential verbatim in the
 * conversation transcript shown in the web CLI.
 *
 * Every capture entry the daemon sends flows through `postIngest`, which
 * calls `redactEntries` here. We deep-walk each entry's string fields and
 * replace any known secret with a fixed marker.
 *
 * This stops casual exposure (`cat ~/.gipity/auth.json`, `env`, an echoed
 * variable). It is NOT a defense against a determined operator who
 * base64/chunks the secret before printing - literal-string matching
 * cannot catch that. The real backstop is a small trusted tester group and
 * an instantly revocable credential.
 */

import type { IngestEntry } from './stream-json.js';

export const REDACTION_MARKER = '[redacted]';

/** Minimum length for a value to be treated as a secret. Guards against a
 *  short or empty env var (e.g. `ANTHROPIC_API_KEY=''`) turning every entry
 *  into a wall of markers. Real credentials are far longer than this. */
const MIN_SECRET_LEN = 12;

/** Matches a JSON Web Token (header.payload.signature, each base64url).
 *  The relay's Gipity access/refresh tokens are JWTs and rotate roughly
 *  every 15 minutes; pattern-redacting them catches a leak even if the
 *  literal-secret list is momentarily stale across a token refresh. A JWT
 *  appearing in a relay transcript is effectively always a credential, so
 *  over-redaction risk is negligible. */
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Anthropic credential tokens: API keys (`sk-ant-api…`) and Claude Code OAuth
 *  tokens (`sk-ant-oat…`). These are NOT JWT-shaped, so the JWT backstop misses
 *  them. On a bring-your-own-key relay the user's own API key lives in the
 *  container env, and a `bypassPermissions` session could otherwise echo it
 *  (`env`, `cat`) into the transcript — so pattern-redact it regardless of the
 *  literal-secret list. An `sk-ant-` token in a relay transcript is always a
 *  credential, so over-redaction risk is negligible. */
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;

/** Well-known third-party credential shapes. A `bypassPermissions` session can
 *  read the host's environment and files, so a `cat .env` / `env` could echo
 *  ANY of these into the transcript - not just the Gipity/Anthropic tokens on
 *  the literal-secret list. Each pattern is a high-entropy, provider-specific
 *  prefix that is effectively never a false positive in a relay transcript, so
 *  the over-redaction risk is the same negligible trade-off already accepted
 *  for the JWT and `sk-ant-` passes. Extend this list as new providers appear;
 *  it is defense-in-depth, NOT a guarantee (a base64/chunked secret still
 *  slips through - the real backstop remains an instantly-revocable
 *  credential). */
const THIRD_PARTY_KEY_RES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,                       // OpenAI (sk-, sk-proj-) + any sk- key
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,            // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g,                        // AWS access key id
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,         // Stripe live secret/restricted key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,            // Slack tokens
  /\bAIza[A-Za-z0-9_-]{35}\b/g,                   // Google API key
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, // PEM private keys
];

/** Replace every occurrence of each known secret - plus any JWT-, Anthropic-,
 *  or well-known-third-party-key-shaped substring - in `text` with the marker. */
function redactString(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTION_MARKER);
  }
  out = out.replace(JWT_RE, REDACTION_MARKER).replace(ANTHROPIC_KEY_RE, REDACTION_MARKER);
  for (const re of THIRD_PARTY_KEY_RES) out = out.replace(re, REDACTION_MARKER);
  return out;
}

/** Deep-walk any JSON-ish value, redacting every string. Returns a new
 *  value; objects/arrays are cloned, primitives passed through. */
function redactValue(node: unknown, secrets: string[]): unknown {
  if (typeof node === 'string') return redactString(node, secrets);
  if (Array.isArray(node)) return node.map(v => redactValue(v, secrets));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = redactValue(v, secrets);
    }
    return out;
  }
  return node;
}

/** Filter a raw secret list down to values worth scrubbing. Drops empties
 *  and short values, dedups, and sorts longest-first so a refresh token
 *  that contains an access token as a substring still redacts cleanly. */
export function normalizeSecrets(raw: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s === 'string' && s.length >= MIN_SECRET_LEN) seen.add(s);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** Redact every known secret - plus any JWT-shaped substring - from a batch
 *  of ingest entries. Walks every string field of every entry
 *  (`tool_result.content`, `assistant.text`/`blocks`, `system.content`,
 *  `prompt`, `tool_use.tool_input`, …). The entry `kind` discriminant is
 *  short and never a secret, so a full walk is safe. Runs even with an
 *  empty `secrets` list because the JWT pass is always applied. Returns a
 *  new array; the input is not mutated. */
export function redactEntries(entries: IngestEntry[], secrets: string[]): IngestEntry[] {
  return entries.map(entry => redactValue(entry, secrets) as IngestEntry);
}

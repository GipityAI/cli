/**
 * Unit tests for the relay secret-redaction pass. No daemon, no network -
 * just `normalizeSecrets` and `redactEntries`. Uses node's built-in runner.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSecrets, redactEntries, REDACTION_MARKER } from '../relay/redact.js';
import type { IngestEntry } from '../relay/stream-json.js';

// A realistic-length fake credential and a short one (must NOT be treated
// as a secret - see MIN_SECRET_LEN guard).
const OAUTH = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const API_KEY = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SHORT = 'abc';

describe('normalizeSecrets', () => {
  it('drops empty, nullish, and too-short values', () => {
    assert.deepEqual(normalizeSecrets([undefined, null, '', SHORT]), []);
  });

  it('dedups and sorts longest-first', () => {
    const longer = API_KEY + 'XXXX';
    const out = normalizeSecrets([API_KEY, longer, API_KEY]);
    assert.deepEqual(out, [longer, API_KEY]);
  });
});

describe('redactEntries', () => {
  it('scrubs a secret out of a tool_result content string', () => {
    const entries: IngestEntry[] = [
      { kind: 'tool_result', tool_use_id: 't1', content: `the token is ${OAUTH} ok` },
    ];
    const [out] = redactEntries(entries, normalizeSecrets([OAUTH]));
    assert.equal((out as any).content, `the token is ${REDACTION_MARKER} ok`);
  });

  it('scrubs a secret out of assistant text and nested blocks', () => {
    const entries: IngestEntry[] = [
      {
        kind: 'assistant',
        text: `here it is: ${API_KEY}`,
        blocks: [{ type: 'text', text: `again ${API_KEY}` }],
      },
    ];
    const [out] = redactEntries(entries, normalizeSecrets([API_KEY]));
    assert.equal((out as any).text, `here it is: ${REDACTION_MARKER}`);
    assert.equal((out as any).blocks[0].text, `again ${REDACTION_MARKER}`);
  });

  it('handles either credential env value (oauth or api key)', () => {
    const entries: IngestEntry[] = [
      { kind: 'system', content: `oauth=${OAUTH} apikey=${API_KEY}` },
    ];
    const [out] = redactEntries(entries, normalizeSecrets([OAUTH, API_KEY]));
    assert.equal((out as any).content, `oauth=${REDACTION_MARKER} apikey=${REDACTION_MARKER}`);
  });

  it('leaves a clean entry untouched', () => {
    const entries: IngestEntry[] = [{ kind: 'prompt', prompt: 'build me a todo app' }];
    const [out] = redactEntries(entries, normalizeSecrets([OAUTH]));
    assert.equal((out as any).prompt, 'build me a todo app');
  });

  it('leaves clean content intact when there are no secrets', () => {
    const entries: IngestEntry[] = [{ kind: 'prompt', prompt: `mentions ${SHORT}` }];
    const [out] = redactEntries(entries, normalizeSecrets([SHORT, '']));
    assert.equal((out as any).prompt, `mentions ${SHORT}`);
  });

  it('redacts a JWT-shaped string even with no literal secrets', () => {
    // Gipity access/refresh tokens are JWTs and rotate; the pattern pass
    // catches them if the literal-secret list is momentarily stale.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjQyfQ.s1gnatur3_AbC-dEf';
    const entries: IngestEntry[] = [
      { kind: 'tool_result', tool_use_id: 't1', content: `"accessToken":"${jwt}"` },
    ];
    const [out] = redactEntries(entries, []);
    assert.equal((out as any).content, `"accessToken":"${REDACTION_MARKER}"`);
  });

  it('does not mutate the input entries', () => {
    const entries: IngestEntry[] = [
      { kind: 'tool_result', tool_use_id: 't1', content: OAUTH },
    ];
    redactEntries(entries, normalizeSecrets([OAUTH]));
    assert.equal((entries[0] as any).content, OAUTH);
  });

  it('pattern-redacts sk-ant- keys (api + oat) even when NOT in the secret list', () => {
    // The BYO-key case: a user's own key isn't in the daemon's literal-secret
    // list, but a bypass session could echo it. The sk-ant- pattern catches it.
    const entries: IngestEntry[] = [
      { kind: 'tool_result', tool_use_id: 't1', content: `ANTHROPIC_API_KEY=${API_KEY}\nTOKEN=${OAUTH}` },
    ];
    const [out] = redactEntries(entries, []); // empty list — pattern pass only
    assert.equal((out as any).content, `ANTHROPIC_API_KEY=${REDACTION_MARKER}\nTOKEN=${REDACTION_MARKER}`);
  });

  it('pattern-redacts common third-party credentials the secret list never sees', () => {
    // A bypassPermissions session can `cat .env` / `env` and echo any of the
    // host's OTHER provider keys - not just Gipity/Anthropic. The provider
    // patterns catch the well-known shapes.
    //
    // Each fake credential is ASSEMBLED from fragments at runtime so no
    // secret-shaped literal ever lives in this source file - GitHub push
    // protection (secret scanning) blocks a commit that contains one verbatim
    // (a literal Stripe-shaped `sk_live_…` string did exactly that). Redaction
    // still receives the full assembled string, so each regex is exercised
    // exactly as it would be against a real leaked key.
    const A = (n: number) => 'A'.repeat(n);
    const cases: Array<[string, string]> = [
      ['OPENAI', 'sk-' + 'proj-' + A(40)],
      ['GITHUB', 'ghp' + '_' + A(36)],
      ['AWS', 'AKIA' + A(16)],
      ['STRIPE', 'sk' + '_live_' + A(24)],
      ['SLACK', 'xoxb' + '-' + A(20)],
      ['GOOGLE', 'AIza' + A(35)],
    ];
    for (const [label, secret] of cases) {
      const entries: IngestEntry[] = [
        { kind: 'tool_result', tool_use_id: 't1', content: `${label}=${secret}` },
      ];
      const [out] = redactEntries(entries, []); // pattern pass only
      assert.equal((out as any).content, `${label}=${REDACTION_MARKER}`, `${label} not redacted`);
    }
  });

  it('pattern-redacts a PEM private key block', () => {
    // BEGIN/END markers assembled from fragments (see above) so the source
    // holds no verbatim private-key header for secret scanning to flag.
    const begin = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
    const end = '-----END ' + 'OPENSSH PRIVATE KEY-----';
    const pem = `${begin}\nZmFrZQ==\n${end}`;
    const entries: IngestEntry[] = [
      { kind: 'tool_result', tool_use_id: 't1', content: `id_ed25519:\n${pem}\ndone` },
    ];
    const [out] = redactEntries(entries, []);
    assert.equal((out as any).content, `id_ed25519:\n${REDACTION_MARKER}\ndone`);
  });
});

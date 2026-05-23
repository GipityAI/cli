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
});

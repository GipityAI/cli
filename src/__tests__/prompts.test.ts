/**
 * Wrap-format contract for relay-dispatched `gipity claude -p` messages.
 *
 * The user's actual message must sit between the `USER_MSG_OPEN` /
 * `USER_MSG_CLOSE` tags with no trailing instructions, and the client-side
 * `stripPreamble` in `platform/client/src/ts/commands/claude-display.ts`
 * must use identical tag strings - otherwise the web CLI renders the full
 * wrap as a `claude>` turn (the historical bug: duplicate user turns
 * rendered as walls of preamble text).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  USER_MSG_OPEN,
  USER_MSG_CLOSE,
  buildFreshWrap,
  buildResumeWrap,
} from '../prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/__tests__/ → repo root depends on build layout. These tests also run
// against the source tree via tsx in CI - handle both by walking up until we
// find the platform/ sibling.
function repoRoot(): string {
  let p = HERE;
  for (let i = 0; i < 8; i++) {
    try {
      const probe = resolve(p, 'platform/client/src/ts/commands/claude-display.ts');
      readFileSync(probe, 'utf-8');
      return p;
    } catch { /* keep walking */ }
    p = resolve(p, '..');
  }
  throw new Error('could not locate repo root from test file');
}

describe('buildFreshWrap', () => {
  it('wraps the user message between USER_MSG_OPEN / USER_MSG_CLOSE', () => {
    const out = buildFreshWrap('## Project context\nstuff here', 'hello world');
    assert.ok(out.includes(USER_MSG_OPEN), 'missing open tag');
    assert.ok(out.includes(USER_MSG_CLOSE), 'missing close tag');
    const open = out.indexOf(USER_MSG_OPEN) + USER_MSG_OPEN.length;
    const close = out.lastIndexOf(USER_MSG_CLOSE);
    assert.equal(out.slice(open, close).trim(), 'hello world');
  });

  it('places the response directive before the user message, not after', () => {
    const out = buildFreshWrap('ctx', 'do a thing');
    const directiveIdx = out.indexOf(`Don't greet`);
    const openIdx = out.indexOf(USER_MSG_OPEN);
    assert.ok(directiveIdx !== -1, 'directive should be present');
    assert.ok(directiveIdx < openIdx, 'directive must come before user-message tag');
  });

  it('has nothing after the closing tag', () => {
    const out = buildFreshWrap('ctx', 'msg');
    assert.ok(out.trimEnd().endsWith(USER_MSG_CLOSE), `wrap should end with close tag, got tail: ${out.slice(-120)}`);
  });

  it('does not emit the legacy "Answer directly" trailer', () => {
    const out = buildFreshWrap('ctx', 'msg');
    assert.equal(out.includes('Answer directly'), false, 'legacy trailer leaked into new wrap');
  });
});

describe('buildResumeWrap', () => {
  const opts = {
    projectName: 'proj',
    projectSlug: 'proj',
    projectGuid: 'p_abc',
    accountSlug: 'acct',
    cwd: '/tmp',
  };

  it('wraps the user message between tags', () => {
    const out = buildResumeWrap(opts, 'whats 2+2');
    const open = out.indexOf(USER_MSG_OPEN) + USER_MSG_OPEN.length;
    const close = out.lastIndexOf(USER_MSG_CLOSE);
    assert.ok(open > USER_MSG_OPEN.length - 1, 'open tag missing');
    assert.ok(close > open, 'close tag missing or before open');
    assert.equal(out.slice(open, close).trim(), 'whats 2+2');
  });

  it('has nothing after the closing tag', () => {
    const out = buildResumeWrap(opts, 'x');
    assert.ok(out.trimEnd().endsWith(USER_MSG_CLOSE));
  });
});

describe('tag constant drift guard', () => {
  it('client-side claude-display.ts uses identical tag strings', () => {
    const root = repoRoot();
    const clientSrc = readFileSync(
      resolve(root, 'platform/client/src/ts/commands/claude-display.ts'),
      'utf-8',
    );
    const openMatch = clientSrc.match(/USER_MSG_OPEN\s*=\s*'([^']+)'/);
    const closeMatch = clientSrc.match(/USER_MSG_CLOSE\s*=\s*'([^']+)'/);
    assert.ok(openMatch, 'claude-display.ts must define USER_MSG_OPEN as a single-quoted string literal');
    assert.ok(closeMatch, 'claude-display.ts must define USER_MSG_CLOSE as a single-quoted string literal');
    assert.equal(openMatch![1], USER_MSG_OPEN, 'open tag drift');
    assert.equal(closeMatch![1], USER_MSG_CLOSE, 'close tag drift');
  });
});

// Local replica of the client-side stripPreamble. The client file can't be
// imported directly (different package, no DOM shim in node:test), so this
// replica + the drift-guard above (identical tag strings) gives equivalent
// coverage. If the algorithm shape changes in claude-display.ts, update
// both here and there.
function stripPreambleReplica(s: string): string {
  if (!s) return s;
  const m1 = s.match(/The user's first message:\s*"([\s\S]+?)"(?:\s*\n|\s*$)/);
  if (m1) return m1[1];
  const open = s.indexOf(USER_MSG_OPEN);
  const close = s.lastIndexOf(USER_MSG_CLOSE);
  if (open !== -1 && close !== -1 && close > open) {
    return s.slice(open + USER_MSG_OPEN.length, close).trim();
  }
  return s;
}

describe('stripPreamble round-trip', () => {
  it('recovers the exact user message from buildFreshWrap output', () => {
    const msg = 'hello world - whats 2+2 and also a newline\nplease';
    const out = buildFreshWrap('## ctx\n- Name: foo\n- Files: empty', msg);
    assert.equal(stripPreambleReplica(out), msg);
  });

  it('recovers the exact user message from buildResumeWrap output', () => {
    const msg = 'resume test message';
    const out = buildResumeWrap(
      { projectName: 'p', projectSlug: 'p', projectGuid: 'p_abc', accountSlug: 'a', cwd: '/' },
      msg,
    );
    assert.equal(stripPreambleReplica(out), msg);
  });

  it('still handles the legacy first-message bootstrap form', () => {
    const s = `Some context\n\nThe user's first message: "build a pacman game"\n\nGet started.`;
    assert.equal(stripPreambleReplica(s), 'build a pacman game');
  });

  it('returns the input unchanged when no tags are present', () => {
    assert.equal(stripPreambleReplica('plain message'), 'plain message');
  });
});

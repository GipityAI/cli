/**
 * Wrap-format contract for relay-dispatched `gipity claude -p` messages.
 *
 * The user's actual message must sit between the `USER_MSG_OPEN` /
 * `USER_MSG_CLOSE` tags with no trailing instructions, so a reader can strip
 * the wrap back to the message (the round-trip below). The web terminal that
 * used to render these turns is archived (archive/web-client in platform), so
 * there is no longer a live client copy of the tags to guard against.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_MSG_OPEN,
  USER_MSG_CLOSE,
  buildFreshWrap,
  buildResumeWrap,
} from '../prompts.js';

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

// Replica of the (now archived) web client's stripPreamble, used here to
// round-trip the CLI's own buildFreshWrap/buildResumeWrap output.
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

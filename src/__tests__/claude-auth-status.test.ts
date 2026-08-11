/**
 * Claude Code auth detection and the "you need to log in" translation.
 *
 * Background: a relay dispatch to a machine whose Claude Code is signed out
 * failed with Claude Code's own "Not logged in · Please run /login". That text
 * is advice for someone sitting at a Claude Code prompt; the person reading it
 * is in a browser on a DIFFERENT machine, where `/login` means nothing and the
 * failing machine isn't even named. These helpers detect the condition
 * authoritatively and say something the reader can act on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeAuthStatus, claudeLoginHint } from '../claude-setup.js';
import { claudeAuthFailureHint } from '../relay/daemon.js';

describe('parseClaudeAuthStatus', () => {
  it('reads a signed-in status', () => {
    const s = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', email: 'a@b.com', subscriptionType: 'max',
    }));
    assert.deepEqual(s, {
      loggedIn: true, authMethod: 'claude.ai', email: 'a@b.com', subscriptionType: 'max',
    });
  });

  it('reads a signed-out status', () => {
    assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))?.loggedIn, false);
  });

  // "Couldn't tell" must never collapse into "logged out": an older Claude Code
  // with no `auth status` subcommand would otherwise have every machine
  // reported as signed out, and every failure blamed on login.
  it('returns null for output it cannot interpret, rather than guessing', () => {
    assert.equal(parseClaudeAuthStatus(''), null);
    assert.equal(parseClaudeAuthStatus('error: unknown command "auth"'), null);
    assert.equal(parseClaudeAuthStatus('{}'), null);
    assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: 'yes' })), null);
  });
});

describe('claudeLoginHint', () => {
  it('names the machine and the command to run there', () => {
    const hint = claudeLoginHint("Wiredcoach's Linux PC");
    assert.match(hint, /Wiredcoach's Linux PC/);
    assert.match(hint, /claude auth login/);
    // The message Claude Code itself gives is useless to a browser reader.
    assert.doesNotMatch(hint, /\/login\b/);
  });

  it('stays sensible when the device has no name', () => {
    assert.match(claudeLoginHint(), /on that machine/);
  });
});

describe('claudeAuthFailureHint', () => {
  const SIGNED_OUT = { loggedIn: false } as const;
  const SIGNED_IN = { loggedIn: true } as const;

  it('translates when Claude Code reports it is signed out', () => {
    const hint = claudeAuthFailureHint(SIGNED_OUT, 'some unrelated stderr', 'box-1');
    assert.match(hint ?? '', /box-1/);
    assert.match(hint ?? '', /claude auth login/);
  });

  it('does NOT translate when Claude Code reports it is signed in', () => {
    // Even though the text matches: the failure was something else, and a
    // prompt that merely CONTAINS "not logged in" must not fake a login error.
    assert.equal(claudeAuthFailureHint(SIGNED_IN, 'Not logged in · Please run /login'), null);
  });

  it('falls back to the stderr shape only when status is unknown', () => {
    assert.ok(claudeAuthFailureHint(null, 'Error: Not logged in · Please run /login'));
    assert.ok(claudeAuthFailureHint(null, 'invalid api key'));
    assert.ok(claudeAuthFailureHint(null, 'OAuth token has expired'));
  });

  it('stays quiet on an ordinary failure', () => {
    assert.equal(claudeAuthFailureHint(null, 'TypeError: undefined is not a function'), null);
    assert.equal(claudeAuthFailureHint(SIGNED_IN, ''), null);
    // The exact stderr from the reported incident: a trust warning, not an auth
    // problem. It must not be rebranded as a login failure.
    assert.equal(
      claudeAuthFailureHint(SIGNED_IN, 'Ignoring 32 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.'),
      null,
    );
  });
});

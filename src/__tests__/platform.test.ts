/**
 * Windows batch-shim handling. `winBatchInvocation` is the pure core of
 * spawnCommand/spawnSyncCommand: it turns a `.cmd`/`.bat` target into a
 * cmd.exe invocation with each token quoted, so Node passes it verbatim
 * (windowsVerbatimArguments) and never trips the post-CVE-2024-27980 EINVAL.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBatchShim, winBatchInvocation } from '../platform.js';

describe('isBatchShim', () => {
  it('is false off win32', () => {
    // The test host is POSIX; a `.cmd` name is not a batch shim here.
    if (process.platform !== 'win32') {
      assert.equal(isBatchShim('C:\\npm\\claude.cmd'), false);
    } else {
      assert.equal(isBatchShim('C:\\npm\\claude.cmd'), true);
      assert.equal(isBatchShim('C:\\npm\\claude.bat'), true);
      assert.equal(isBatchShim('C:\\bin\\claude.exe'), false);
    }
  });
});

describe('winBatchInvocation', () => {
  it('wraps the shim + args in a single quoted cmd.exe /c line', () => {
    const inv = winBatchInvocation('C:\\npm\\claude.cmd', ['plugin', 'install', '--scope', 'user']);
    // cmd.exe (or ComSpec), then /d /s /c, then ONE argument: the whole
    // quoted line. /s + outer quotes make cmd strip exactly the outer pair.
    assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(inv.args.length, 4);
    assert.equal(
      inv.args[3],
      '""C:\\npm\\claude.cmd" "plugin" "install" "--scope" "user""',
    );
  });

  it('quotes args containing spaces so they survive as one token', () => {
    const inv = winBatchInvocation('gipity.cmd', ['sync', 'a b c']);
    assert.equal(inv.args[3], '""gipity.cmd" "sync" "a b c""');
  });

  it('escapes embedded double-quotes', () => {
    const inv = winBatchInvocation('gipity.cmd', ['say "hi"']);
    assert.equal(inv.args[3], '""gipity.cmd" "say ""hi""""');
  });
});

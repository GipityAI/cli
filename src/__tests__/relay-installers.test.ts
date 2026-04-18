/**
 * Platform-specific service-unit generation — pure file-content checks.
 * Actually running launchctl/systemctl/schtasks is user-driven; not tested.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planFor, UnsupportedPlatformError } from '../relay/installers.js';

const CLI = '/usr/local/bin/gipity';

describe('installers: platform dispatch', () => {
  it('returns a darwin plan on darwin', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'darwin' });
    assert.equal(p.platform, 'darwin');
    assert.match(p.path, /Library\/LaunchAgents\/ai\.gipity\.relay\.plist$/);
  });

  it('returns a linux plan on linux', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'linux' });
    assert.equal(p.platform, 'linux');
    assert.match(p.path, /\.config\/systemd\/user\/gipity-relay\.service$/);
  });

  it('returns a win32 plan on win32', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'win32' });
    assert.equal(p.platform, 'win32');
    assert.match(p.path, /Gipity.*relay-task\.xml$/);
  });

  it('throws UnsupportedPlatformError on anything else', () => {
    assert.throws(
      () => planFor({ cliPath: CLI, platformOverride: 'plan9' }),
      UnsupportedPlatformError,
    );
  });
});

describe('installers: content renders CLI path correctly', () => {
  it('launchd plist embeds the CLI path and `relay run` args', () => {
    const p = planFor({ cliPath: '/opt/homebrew/bin/gipity', platformOverride: 'darwin' });
    assert.match(p.content, /<string>\/opt\/homebrew\/bin\/gipity<\/string>/);
    assert.match(p.content, /<string>relay<\/string>/);
    assert.match(p.content, /<string>run<\/string>/);
    assert.match(p.content, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(p.content, /<key>KeepAlive<\/key><true\/>/);
  });

  it('systemd unit embeds ExecStart with the CLI path + relay run', () => {
    const p = planFor({ cliPath: '/home/me/.npm-global/bin/gipity', platformOverride: 'linux' });
    assert.match(p.content, /^ExecStart=\/home\/me\/\.npm-global\/bin\/gipity relay run$/m);
    assert.match(p.content, /Restart=on-failure/);
    assert.match(p.content, /WantedBy=default\.target/);
  });

  it('Task Scheduler XML embeds Command + Arguments', () => {
    const p = planFor({ cliPath: 'C:\\Users\\Me\\AppData\\Roaming\\npm\\gipity.cmd', platformOverride: 'win32' });
    assert.match(p.content, /<Command>C:\\\\Users\\\\Me\\\\AppData\\\\Roaming\\\\npm\\\\gipity\.cmd<\/Command>|<Command>C:\\Users\\Me\\AppData\\Roaming\\npm\\gipity\.cmd<\/Command>/);
    assert.match(p.content, /<Arguments>relay run<\/Arguments>/);
    assert.match(p.content, /<LogonTrigger>/);
  });
});

describe('installers: enable/disable commands look right', () => {
  it('launchd uses launchctl bootstrap/bootout with a resolved gui/<uid>', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'darwin' });
    // uid is resolved at plan time (process.getuid()) so no shell substitution.
    assert.deepEqual(p.enableCmds[0].slice(0, 2), ['launchctl', 'bootstrap']);
    assert.match(p.enableCmds[0][2], /^gui\/\d+$/);
    assert.deepEqual(p.disableCmds[0].slice(0, 2), ['launchctl', 'bootout']);
    assert.match(p.disableCmds[0][2], /^gui\/\d+$/);
  });

  it('systemd uses systemctl --user enable --now and disable --now', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'linux' });
    // daemon-reload first, then enable --now.
    assert.deepEqual(p.enableCmds[0], ['systemctl', '--user', 'daemon-reload']);
    assert.deepEqual(p.enableCmds[1], ['systemctl', '--user', 'enable', '--now', 'gipity-relay.service']);
    assert.deepEqual(p.disableCmds[0], ['systemctl', '--user', 'disable', '--now', 'gipity-relay.service']);
  });

  it('Windows uses schtasks Create with /F (force overwrite) and Delete', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'win32' });
    // Two-step enable: Create then Run. Two-step disable: End then Delete.
    assert.equal(p.enableCmds[0][0], 'schtasks');
    assert.ok(p.enableCmds[0].includes('/Create'));
    assert.ok(p.enableCmds[0].includes('/F'));
    assert.equal(p.enableCmds[1][0], 'schtasks');
    assert.ok(p.enableCmds[1].includes('/Run'));
    assert.ok(p.disableCmds.some(argv => argv.includes('/Delete')));
  });

  it('argv arrays are flat string arrays — no shell metacharacters injected', () => {
    // A path with spaces must stay as a single argv slot, not split by sh.
    const cliPath = '/Users/Test User/.npm-global/bin/gipity';
    const p = planFor({ cliPath, platformOverride: 'darwin' });
    // The plist path also contains the homedir, which on the test runner
    // doesn't contain spaces — but the contract is still: argv elements
    // are single strings, never shell-tokenized.
    for (const argv of [...p.enableCmds, ...p.disableCmds, p.statusCmd]) {
      for (const part of argv) {
        assert.equal(typeof part, 'string');
        assert.ok(!part.includes('\n'), 'argv parts should not contain newlines');
      }
    }
    // CLI path is embedded in the plist content (file body), not the argv —
    // sanity check that didn't change.
    assert.match(p.content, /<string>\/Users\/Test User\/\.npm-global\/bin\/gipity<\/string>/);
  });
});

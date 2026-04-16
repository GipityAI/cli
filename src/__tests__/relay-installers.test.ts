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
  it('launchd uses launchctl bootstrap/bootout with gui/<uid>', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'darwin' });
    assert.match(p.enableCmd, /launchctl bootstrap gui\/\$\(id -u\)/);
    assert.match(p.disableCmd, /launchctl bootout gui\/\$\(id -u\)/);
  });

  it('systemd uses systemctl --user enable --now and disable --now', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'linux' });
    assert.match(p.enableCmd, /systemctl --user enable --now gipity-relay\.service/);
    assert.match(p.disableCmd, /systemctl --user disable --now gipity-relay\.service/);
  });

  it('Windows uses schtasks Create with /F (force overwrite) and Delete', () => {
    const p = planFor({ cliPath: CLI, platformOverride: 'win32' });
    assert.match(p.enableCmd, /schtasks \/Create.*\/F/);
    assert.match(p.enableCmd, /schtasks \/Run/);
    assert.match(p.disableCmd, /schtasks \/Delete.*\/F/);
  });
});

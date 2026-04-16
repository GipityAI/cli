/**
 * Platform-specific service-unit generation for `gipity relay install`.
 *
 * Each platform returns:
 *   - `path`          — where to write the unit file
 *   - `content`       — the rendered file body
 *   - `enableCmd`     — shell command to register + start the service
 *   - `disableCmd`    — shell command to stop + unregister the service
 *   - `statusCmd`     — shell command a user can run to check the service
 *
 * File-content generation is pure + unit-tested. Actually running the
 * enable/disable/status commands happens in the CLI command layer so tests
 * don't shell out to systemctl/launchctl/schtasks.
 */
import { homedir, platform as osPlatform } from 'os';
import { join } from 'path';

export interface InstallerPlan {
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  content: string;
  enableCmd: string;
  disableCmd: string;
  statusCmd: string;
  /** A user-readable sentence describing what this platform's unit does. */
  summary: string;
}

export class UnsupportedPlatformError extends Error {
  constructor(plat: string) { super(`gipity relay install does not support ${plat}`); }
}

/** Pick the right plan for the current OS and CLI path. */
export function planFor(opts: { cliPath: string; platformOverride?: string }): InstallerPlan {
  const plat = (opts.platformOverride ?? osPlatform()) as 'darwin' | 'linux' | 'win32' | string;
  if (plat === 'darwin') return launchdPlan(opts.cliPath);
  if (plat === 'linux')  return systemdUserPlan(opts.cliPath);
  if (plat === 'win32')  return windowsTaskPlan(opts.cliPath);
  throw new UnsupportedPlatformError(plat);
}

// ─── macOS — launchd (user LaunchAgent) ────────────────────────────────

function launchdPlan(cliPath: string): InstallerPlan {
  const label = 'ai.gipity.relay';
  const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const logDir = join(homedir(), 'Library', 'Logs', 'Gipity');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cliPath}</string>
    <string>relay</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, 'relay.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'relay.err.log')}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  return {
    platform: 'darwin',
    path,
    content,
    enableCmd: `launchctl bootstrap gui/$(id -u) "${path}"`,
    disableCmd: `launchctl bootout gui/$(id -u) "${path}"`,
    statusCmd: `launchctl print gui/$(id -u)/${label}`,
    summary: 'LaunchAgent at ~/Library/LaunchAgents/ai.gipity.relay.plist (starts at login, auto-restarts)',
  };
}

// ─── Linux — systemd --user unit ───────────────────────────────────────

function systemdUserPlan(cliPath: string): InstallerPlan {
  const unitName = 'gipity-relay.service';
  const path = join(homedir(), '.config', 'systemd', 'user', unitName);
  const content = `[Unit]
Description=Gipity relay — local Claude Code control from the Gipity web CLI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${cliPath} relay run
Restart=on-failure
RestartSec=5
# Logs land in journal via default StandardOutput/Error=journal; duplicated
# to ~/.gipity/relay.log by the daemon itself for \`gipity relay log\`.

[Install]
WantedBy=default.target
`;
  return {
    platform: 'linux',
    path,
    content,
    enableCmd: `systemctl --user daemon-reload && systemctl --user enable --now ${unitName}`,
    disableCmd: `systemctl --user disable --now ${unitName}`,
    statusCmd: `systemctl --user status ${unitName}`,
    summary: `systemd user unit at ~/.config/systemd/user/${unitName} (starts on login, restarts on failure)`,
  };
}

// ─── Windows — Task Scheduler XML ──────────────────────────────────────

function windowsTaskPlan(cliPath: string): InstallerPlan {
  const taskName = 'GipityRelay';
  const path = join(homedir(), 'AppData', 'Local', 'Gipity', 'relay-task.xml');
  // Minimal Task Scheduler XML: triggers at logon, runs the CLI, restarts
  // on failure up to 999 times with a 1-minute gap.
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Gipity relay — local Claude Code control from the Gipity web CLI</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
  </Settings>
  <Actions>
    <Exec>
      <Command>${cliPath}</Command>
      <Arguments>relay run</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  return {
    platform: 'win32',
    path,
    content,
    enableCmd: `schtasks /Create /TN "${taskName}" /XML "${path}" /F && schtasks /Run /TN "${taskName}"`,
    disableCmd: `schtasks /End /TN "${taskName}" & schtasks /Delete /TN "${taskName}" /F`,
    statusCmd: `schtasks /Query /TN "${taskName}" /V /FO LIST`,
    summary: `Task Scheduler task "${taskName}" (starts at logon, restarts on failure)`,
  };
}

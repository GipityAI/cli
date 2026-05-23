/**
 * Stable per-machine fingerprint for relay device dedup.
 *
 * Sent on device registration (`POST /remote-devices`) so the server can
 * recognize a re-pair from the same computer - a reinstall, a wiped
 * `~/.gipity`, or a re-provisioned relay-host container - and reuse that
 * device's row instead of leaving a stale duplicate in the user's `/cc`
 * list.
 *
 * Sources, in priority order:
 *   1. GIPITY_RELAY_MACHINE_ID env override - used by hosted relay-host
 *      containers, which have no stable native id of their own; the
 *      provisioner sets it to something stable per tester.
 *   2. The OS machine id (Linux /etc/machine-id, macOS IOPlatformUUID,
 *      Windows MachineGuid).
 *   3. A hostname-based fallback - weaker (hostname can change) but still
 *      better than registering a brand-new device on every run.
 *
 * Whatever is found is sha256-hashed to a uniform, opaque 64-char hex
 * string: stable, not personally identifying, and a fixed width for the
 * server's VARCHAR(64) column.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { hostname, platform, arch } from 'os';

/** Resolve the rawest stable identifier available for this machine. The
 *  per-source prefix keeps ids from different sources in distinct spaces. */
function rawMachineId(): string {
  const override = process.env.GIPITY_RELAY_MACHINE_ID?.trim();
  if (override) return `override:${override}`;

  try {
    if (platform() === 'linux') {
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = readFileSync(path, 'utf-8').trim();
          if (id) return `linux:${id}`;
        } catch { /* try the next path */ }
      }
    } else if (platform() === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return `darwin:${m[1]}`;
    } else if (platform() === 'win32') {
      const out = execFileSync(
        'reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf-8' },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([A-Fa-f0-9-]+)/);
      if (m) return `win32:${m[1]}`;
    }
  } catch { /* fall through to the hostname fallback */ }

  return `fallback:${hostname()}:${platform()}:${arch()}`;
}

/** sha256 hex (64 chars) of this machine's stable id. Deterministic. */
export function getMachineId(): string {
  return createHash('sha256').update(rawMachineId()).digest('hex');
}

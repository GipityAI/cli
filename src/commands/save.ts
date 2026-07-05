/**
 * `gipity save [output]` - export the linked project as a portable .gip bundle.
 *
 * A .gip is a zip of the project's file tree plus a reserved
 * `_gip/manifest.json` metadata entry. It pairs with `gipity load`, which
 * creates a brand-new project from a bundle. Code-only: secrets, custom
 * domains, chats, and database rows are never in a .gip.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Command } from 'commander';
import { downloadWithHeaders } from '../api.js';
import { requireConfig } from '../config.js';
import { success, muted, warning } from '../colors.js';
import { run } from '../helpers/index.js';
import { withSpinner } from '../progress.js';
import { formatBytes } from '../adopt-cwd.js';

/** Count archive entries by reading the zip end-of-central-directory record -
 *  cheap (no inflation, no dependency) and good enough for a summary line.
 *  Returns null when the record can't be found or the count is zip64-saturated,
 *  in which case the line is simply omitted. */
export function zipEntryCount(buf: Buffer): number | null {
  const EOCD_SIG = 0x06054b50;
  const MIN_EOCD = 22; // fixed EOCD size with an empty comment
  if (buf.length < MIN_EOCD) return null;
  // The EOCD sits at the end, preceded only by an optional comment (<= 64KB).
  const floor = Math.max(0, buf.length - MIN_EOCD - 0xffff);
  for (let i = buf.length - MIN_EOCD; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const n = buf.readUInt16LE(i + 10); // total central-directory records
      return n === 0xffff ? null : n;
    }
  }
  return null;
}

/** Pull the server's suggested filename out of Content-Disposition
 *  (`attachment; filename="<slug>.gip"`). The server slug is fresher than the
 *  locally cached one if the project was renamed. */
function dispositionFilename(headers: Headers): string | null {
  const m = /filename="([^"]+)"/.exec(headers.get('content-disposition') ?? '');
  return m ? m[1] : null;
}

export const saveCommand = new Command('save')
  .description('Save this app as a portable .gip bundle')
  .argument('[output]', 'Output .gip path, or a directory to write <slug>.gip into (default: ./<slug>.gip)')
  .option('--json', 'Output as JSON')
  .addHelpText('after', '\nRestore anywhere with `gipity load <file>.gip` - it always creates a NEW project.')
  .action((output: string | undefined, opts) => run('Save', async () => {
    const config = requireConfig();

    const doExport = () => downloadWithHeaders(`/projects/${config.projectGuid}/export`);
    const { buffer, headers } = opts.json
      ? await doExport()
      : await withSpinner('Exporting…', doExport, { done: null });

    const filename = dispositionFilename(headers) ?? `${config.projectSlug}.gip`;
    let dest = path.resolve(output ?? filename);
    if (output && fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
      dest = path.join(dest, filename);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const skipped = Number(headers.get('x-gip-skipped') ?? 0);
    const entries = zipEntryCount(buffer);

    if (opts.json) {
      console.log(JSON.stringify({
        path: dest,
        bytes: buffer.length,
        sha256,
        ...(entries !== null ? { entries } : {}),
        skipped,
      }));
      return;
    }

    console.log(success(`Saved ${path.basename(dest)}`));
    console.log(`  Path:     ${dest}`);
    console.log(`  Size:     ${formatBytes(buffer.length)}`);
    if (entries !== null) console.log(`  Entries:  ${entries} (including the bundle manifest)`);
    console.log(`  SHA-256:  ${sha256}`);
    if (skipped > 0) {
      console.log('');
      console.warn(warning(`${skipped} file(s) were skipped (unreadable or over 100 MB) - this bundle is partial.`));
      console.warn(warning('Large assets belong in Gipity Storage, not in a code bundle.'));
    }
    console.log('');
    console.log(muted('Restore anywhere with `gipity load ' + path.basename(dest) + '` (creates a new project).'));
  }));

import { Command } from 'commander';
import { statSync, readdirSync } from 'fs';
import { join, basename, posix, resolve, dirname } from 'path';
import { resolveProjectContext } from '../config.js';
import { uploadOneFile, hashFile, guessMime, UPLOAD_CONCURRENCY } from '../upload.js';
import { formatSize } from '../utils.js';
import { error as clrError, dim } from '../colors.js';

interface UploadOpts {
  recursive?: boolean;
  overwrite?: boolean;
  mime?: string;
  concurrency?: string;
  dryRun?: boolean;
  project?: string;
}

interface PlannedFile {
  localPath: string;
  virtualPath: string;
  size: number;
}

/** Walk a directory recursively, returning every file's absolute path. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

/** Compose the destination virtual path for a given source file under a recursive walk. */
function destFor(localFile: string, srcRoot: string, destRoot: string): string {
  // POSIX-style virtual paths regardless of host OS.
  const rel = localFile.slice(srcRoot.length).replace(/\\/g, '/').replace(/^\/+/, '');
  return posix.join(destRoot.replace(/\\/g, '/').replace(/\/$/, ''), rel);
}

export const uploadCommand = new Command('upload')
  .description('Upload a local file or directory to a Gipity project')
  .argument('<src>', 'Local source file or directory')
  .argument('[dest]', 'Destination path in the project (defaults to /)')
  .option('-r, --recursive', 'Upload a directory recursively')
  .option('--overwrite', 'Force a new version even if the file is byte-identical to the current version')
  .option('--mime <type>', 'Override the content-type (default: detect from extension)')
  .option('--concurrency <n>', `Parallel files (default ${UPLOAD_CONCURRENCY})`)
  .option('--dry-run', 'Print what would be uploaded; do not call the network')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .action(async (src: string, destArg: string | undefined, opts: UploadOpts) => {
    try {
      const { config } = await resolveProjectContext({ projectOverride: opts.project });
      const dest = destArg ?? '/';
      const srcStat = statSync(src);

      // Collect the work plan.
      const planned: PlannedFile[] = [];
      if (srcStat.isDirectory()) {
        if (!opts.recursive) {
          throw new Error(`${src} is a directory — pass -r/--recursive to upload it`);
        }
        // Slice from the parent of src so the directory name itself is preserved
        // in the virtual path (e.g. `hooks/a.sh` → `hooks/a.sh`, not `a.sh`).
        const srcAbs = resolve(src);
        const sliceRoot = dirname(srcAbs);
        for (const file of walkFiles(src)) {
          planned.push({
            localPath: file,
            virtualPath: destFor(resolve(file), sliceRoot, dest),
            size: statSync(file).size,
          });
        }
      } else if (srcStat.isFile()) {
        // If dest looks like a directory (ends in / or no extension on a file path), append basename.
        const looksLikeDir = dest.endsWith('/') || (opts.recursive === true);
        const virtualPath = looksLikeDir
          ? posix.join(dest.replace(/\/$/, ''), basename(src))
          : dest;
        planned.push({ localPath: src, virtualPath, size: srcStat.size });
      } else {
        throw new Error(`${src} is neither a regular file nor a directory`);
      }

      if (planned.length === 0) {
        console.log('Nothing to upload (0 files).');
        return;
      }

      const totalBytes = planned.reduce((s, f) => s + f.size, 0);
      console.log(`Plan: ${planned.length} file${planned.length > 1 ? 's' : ''}, ${formatSize(totalBytes)}`);
      for (const f of planned) {
        console.log(`  ${f.localPath} ${dim('→')} ${f.virtualPath} (${formatSize(f.size)})`);
      }

      if (opts.dryRun) {
        console.log('\n--dry-run: skipping all network calls.');
        return;
      }

      const concurrency = Math.max(1, parseInt(opts.concurrency ?? String(UPLOAD_CONCURRENCY), 10));
      const uploadOpts = { mime: opts.mime, overwrite: opts.overwrite };

      let cursor = 0;
      let uploaded = 0, skipped = 0, resumed = 0, failed = 0;
      const workers: Array<Promise<void>> = [];
      for (let w = 0; w < Math.min(concurrency, planned.length); w++) {
        workers.push((async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= planned.length) return;
            const f = planned[idx];
            try {
              const result = await uploadOneFile(config.projectGuid, f.localPath, f.virtualPath, uploadOpts);
              if (result.status === 'skipped') {
                skipped++;
                console.log(`  ${dim('skip')} ${f.virtualPath} (already current)`);
              } else if (result.status === 'resumed') {
                resumed++;
                console.log(`  ${dim('resumed')} ${f.virtualPath} v${result.version}`);
              } else {
                uploaded++;
                console.log(`  ${dim('uploaded')} ${f.virtualPath} v${result.version}`);
              }
            } catch (err) {
              failed++;
              console.error(clrError(`  fail ${f.virtualPath}: ${(err as Error).message}`));
            }
          }
        })());
      }
      await Promise.all(workers);

      console.log(`\nUploaded: ${uploaded}, Resumed: ${resumed}, Skipped: ${skipped}, Failed: ${failed}`);
      if (failed > 0) process.exit(1);
    } catch (err) {
      console.error(clrError(`Upload failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

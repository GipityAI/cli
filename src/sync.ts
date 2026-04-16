import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, readdirSync, rmdirSync, readFileSync } from 'fs';
import { join, relative, dirname } from 'path';
import { createHash } from 'crypto';
import { get, del, downloadStream } from './api.js';
import { requireConfig, shouldIgnore, getConfigPath } from './config.js';
import { formatSize, formatAge, prompt, getAutoConfirm } from './utils.js';
import { uploadOneFile, UPLOAD_CONCURRENCY, hashFile } from './upload.js';
import * as tar from 'tar-stream';

interface RemoteFile {
  path: string;
  size: number;
  modified: string;
  type: string;
  guid: string;
  contentHash?: string | null;
}

export interface LocalFileInfo {
  size: number;
  modified: string;
  sha256?: string;
}

type BaselineEntry = LocalFileInfo;

interface SyncState {
  lastSync: string;
  files: Record<string, BaselineEntry>;
  lastPull?: { timestamp: string; count: number; summary: string };
}

export interface SyncChange {
  type: 'added' | 'modified' | 'deleted' | 'conflict';
  path: string;
  localSize?: number;
  remoteSize?: number;
}

export interface SyncResult {
  changes: SyncChange[];
  pulled: number;
  pushed: number;
  deleted: number;
  skippedDeletions: number;
  summary: string;
}

export interface SyncDownOptions {
  /** If true, prompt user to confirm before deleting files. Default: false (skip deletions silently). */
  confirmDeletions?: boolean;
}

function syncStatePath(): string {
  const configPath = getConfigPath()!;
  const projectDir = dirname(configPath);
  return join(projectDir, '.gipity', 'sync-state.json');
}

function projectDir(): string {
  const configPath = getConfigPath()!;
  return dirname(configPath);
}

function loadSyncState(): SyncState {
  const path = syncStatePath();
  if (!existsSync(path)) return { lastSync: '', files: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { lastSync: '', files: {} };
  }
}

function saveSyncState(state: SyncState): void {
  const path = syncStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Walk local directory, returning relative paths, sizes, and mtimes.
 *  Reuses a cached sha256 from the baseline when (size, mtime) are unchanged,
 *  so unchanged files are never rehashed. Does NOT compute hashes for changed
 *  files — call {@link ensureLocalHashes} on-demand when a hash is needed. */
function walkLocal(
  dir: string,
  base: string,
  ignorePatterns: string[],
  baseline: Record<string, BaselineEntry> = {},
): Map<string, LocalFileInfo> {
  const result = new Map<string, LocalFileInfo>();

  function walk(currentDir: string) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(base, fullPath).replace(/\\/g, '/');

      if (shouldIgnore(relPath, ignorePatterns)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = statSync(fullPath);
          const size = stat.size;
          const modified = stat.mtime.toISOString();
          const prior = baseline[relPath];
          const sha256 = prior && prior.size === size && prior.modified === modified
            ? prior.sha256
            : undefined;
          result.set(relPath, { size, modified, sha256 });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return result;
}

/** Populate sha256 for the given local files by reading+hashing any that
 *  don't already have one. Called on-demand when hashes are needed for
 *  conflict resolution. */
async function ensureLocalHashes(
  root: string,
  localFiles: Map<string, LocalFileInfo>,
  paths: Iterable<string>,
): Promise<void> {
  for (const path of paths) {
    const info = localFiles.get(path);
    if (!info || info.sha256) continue;
    try {
      const { sha256 } = await hashFile(join(root, path));
      info.sha256 = sha256;
    } catch {
      // skip unreadable files
    }
  }
}

/** Compare a local file to a remote file, preferring hash when both sides have it. */
function sameContent(local: LocalFileInfo, remote: RemoteFile): boolean {
  if (local.sha256 && remote.contentHash) {
    return local.sha256 === remote.contentHash;
  }
  // Fallback when hashes aren't available: size-only (legacy behavior).
  return local.size === remote.size;
}

/** Fetch remote file manifest */
async function fetchManifest(projectGuid: string, prefix?: string): Promise<RemoteFile[]> {
  const query = prefix ? `?path=${encodeURIComponent(prefix)}` : '';
  const res = await get<{ data: RemoteFile[] }>(`/projects/${projectGuid}/files/tree${query}`);
  return res.data;
}

/** Download all remote files as a tar stream, returning path → Buffer map */
async function downloadAllFiles(projectGuid: string): Promise<Map<string, Buffer>> {
  const stream = await downloadStream(`/projects/${projectGuid}/files/tree?content=tar`);
  const extract = tar.extract();
  const files = new Map<string, Buffer>();

  return new Promise((resolve, reject) => {
    extract.on('entry', (header, entryStream, next) => {
      const chunks: Buffer[] = [];
      entryStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      entryStream.on('end', () => {
        files.set(header.name, Buffer.concat(chunks));
        next();
      });
      entryStream.resume();
    });
    extract.on('finish', () => resolve(files));
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

/** Compare remote manifest against local files, detect changes.
 *  Prefers sha256 hash comparison when both sides have hashes. When a baseline
 *  is provided, detects three-way conflicts (both sides changed since last sync)
 *  and emits a `conflict` change instead of silently overwriting. */
export function diffManifest(
  remoteFiles: RemoteFile[],
  localFiles: Map<string, LocalFileInfo>,
  direction: 'down' | 'up',
  baseline: Record<string, BaselineEntry> = {},
): SyncChange[] {
  const changes: SyncChange[] = [];
  const remoteMap = new Map(remoteFiles.filter(f => f.type === 'file').map(f => [f.path, f]));

  if (direction === 'down') {
    for (const [path, remote] of remoteMap) {
      const local = localFiles.get(path);
      if (!local) {
        changes.push({ type: 'added', path, remoteSize: remote.size });
        continue;
      }
      if (sameContent(local, remote)) continue;

      // Remote and local differ. Use baseline to decide: pull, no-op, or conflict.
      const base = baseline[path];
      const localMatchesBaseline = base?.sha256 && local.sha256 && base.sha256 === local.sha256;
      const remoteMatchesBaseline = base?.sha256 && remote.contentHash && base.sha256 === remote.contentHash;

      if (localMatchesBaseline) {
        // Local unchanged since last sync → remote is newer, safe to pull.
        changes.push({ type: 'modified', path, localSize: local.size, remoteSize: remote.size });
      } else if (remoteMatchesBaseline) {
        // Remote unchanged since last sync, but local diverged. On a `down`,
        // don't clobber local edits — skip silently.
        continue;
      } else {
        // No baseline, or both sides moved. Fall back to the legacy size heuristic
        // when we have no hash info, but on any hash-based divergence treat it as a conflict.
        if (!local.sha256 || !remote.contentHash) {
          changes.push({ type: 'modified', path, localSize: local.size, remoteSize: remote.size });
        } else {
          changes.push({ type: 'conflict', path, localSize: local.size, remoteSize: remote.size });
        }
      }
    }

    for (const [path, local] of localFiles) {
      if (!remoteMap.has(path)) {
        changes.push({ type: 'deleted', path, localSize: local.size });
      }
    }
  } else {
    for (const [path, local] of localFiles) {
      const remote = remoteMap.get(path);
      if (!remote) {
        changes.push({ type: 'added', path, localSize: local.size });
        continue;
      }
      if (sameContent(local, remote)) continue;
      changes.push({ type: 'modified', path, localSize: local.size, remoteSize: remote.size });
    }

    for (const [path, remote] of remoteMap) {
      if (!localFiles.has(path)) {
        changes.push({ type: 'deleted', path, remoteSize: remote.size });
      }
    }
  }

  return changes;
}

export function formatDiff(
  changes: SyncChange[],
  direction: 'down' | 'up',
  lastPull?: { timestamp: string; count: number; summary: string },
): string {
  if (changes.length === 0) {
    if (direction === 'down' && lastPull) {
      const age = formatAge(lastPull.timestamp);
      return `Already up to date. (${lastPull.count} file${lastPull.count > 1 ? 's' : ''} pulled ${age})`;
    }
    return 'No changes detected.';
  }

  const label = direction === 'down' ? 'remotely' : 'locally';
  const lines = [`${changes.length} change${changes.length > 1 ? 's' : ''}:`];

  for (const c of changes) {
    switch (c.type) {
      case 'added':
        lines.push(`  + ${c.path} (new, ${formatSize(c.remoteSize || c.localSize || 0)})`);
        break;
      case 'modified':
        lines.push(`  ~ ${c.path} (${formatSize(c.localSize || 0)} → ${formatSize(c.remoteSize || 0)})`);
        break;
      case 'deleted':
        lines.push(`  - ${c.path} (deleted ${label})`);
        break;
      case 'conflict':
        lines.push(`  ! ${c.path} (conflict — both sides changed; local ${formatSize(c.localSize || 0)}, remote ${formatSize(c.remoteSize || 0)})`);
        break;
    }
  }

  return lines.join('\n');
}

/** Prompt the user to resolve sync-down conflicts. Returns the set of paths the
 *  user elected to overwrite with the remote version. Paths not in the set keep
 *  their local content. */
async function resolveConflicts(conflicts: SyncChange[]): Promise<Set<string>> {
  const takeRemote = new Set<string>();
  const count = conflicts.length;

  console.log(`\n${count} conflict${count > 1 ? 's' : ''} — both local and remote changed since the last sync:`);
  for (const c of conflicts) {
    console.log(`  ! ${c.path} (local ${formatSize(c.localSize || 0)}, remote ${formatSize(c.remoteSize || 0)})`);
  }

  if (getAutoConfirm()) {
    // Auto-confirm mode: preserve local (safe default).
    console.log('Auto-confirm: keeping local for all conflicts. Run interactively to choose per-file.');
    return takeRemote;
  }

  const answer = (await prompt(
    `\nFor each conflict: (l)ocal keeps, (r)emote overwrites, (s)kip all. [l/r/s] `,
  )).trim().toLowerCase();

  if (answer === 'r') {
    for (const c of conflicts) takeRemote.add(c.path);
  }
  // 'l' or 's' or anything else → keep local (empty set)
  return takeRemote;
}

/** Confirm file deletions with the user. Returns true if deletions should proceed. */
async function confirmFileDeletions(deletions: SyncChange[]): Promise<boolean> {
  if (getAutoConfirm()) return true;
  const count = deletions.length;

  if (count <= 10) {
    // Show each file, simple y/n
    console.log(`\nSync will delete ${count} local file${count > 1 ? 's' : ''}:`);
    for (const d of deletions) {
      console.log(`  - ${d.path}`);
    }
    const answer = await prompt(`\nDelete ${count} file${count > 1 ? 's' : ''}? (y/n) `);
    return answer.trim().toLowerCase() === 'y';
  }

  // 10+ files — show summary + sample, require typing "delete"
  console.log(`\nSync will delete ${count} local files. Examples:`);
  for (const d of deletions.slice(0, 5)) {
    console.log(`  - ${d.path}`);
  }
  console.log(`  ... and ${count - 5} more`);
  const answer = await prompt(`\nType "delete" to confirm, or anything else to skip: `);
  return answer.trim().toLowerCase() === 'delete';
}

/** Sync down: pull remote changes to local */
export async function syncDown(opts: SyncDownOptions = {}): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const remoteFiles = await fetchManifest(config.projectGuid);
  const previousState = loadSyncState();
  const baseline = previousState.files;
  const localFiles = walkLocal(root, root, config.ignore, baseline);

  // For any file where remote content differs from cached local (size/mtime-based)
  // or whose baseline doesn't have a cached hash, compute sha256 so we can make
  // an accurate three-way decision. This is the only place we pay I/O for hashing.
  const remoteByPath = new Map(remoteFiles.filter(f => f.type === 'file').map(f => [f.path, f]));
  const needHash: string[] = [];
  for (const [path, local] of localFiles) {
    const remote = remoteByPath.get(path);
    if (!remote) continue;
    if (local.sha256) continue;
    // Hash when (size matches remote but we can't tell) OR (size differs AND baseline existed — may be a conflict)
    if (remote.contentHash) needHash.push(path);
  }
  await ensureLocalHashes(root, localFiles, needHash);

  const changes = diffManifest(remoteFiles, localFiles, 'down', baseline);

  // Resolve conflicts before any writes.
  const conflicts = changes.filter(c => c.type === 'conflict');
  let pullOverrides = new Set<string>(); // paths where user chose to take remote
  if (conflicts.length > 0) {
    if (opts.confirmDeletions) {
      pullOverrides = await resolveConflicts(conflicts);
    } else {
      // Non-interactive (relay/hooks) — never clobber. Log and skip.
      for (const c of conflicts) {
        console.warn(`[sync] conflict: ${c.path} — local and remote both changed; keeping local. Run \`gipity sync\` interactively to resolve.`);
      }
    }
  }

  const remoteFileCount = remoteFiles.filter(f => f.type === 'file').length;
  const deletions = changes.filter(c => c.type === 'deleted');

  // Decide whether to execute deletions
  let executeDeletions = false;
  let skippedDeletions = 0;

  if (deletions.length > 0) {
    if (remoteFileCount === 0) {
      // Remote is empty — never delete local files (prevents wiping on fresh init)
      executeDeletions = false;
      skippedDeletions = deletions.length;
    } else if (opts.confirmDeletions) {
      // Interactive mode — ask user
      executeDeletions = await confirmFileDeletions(deletions);
      if (!executeDeletions) skippedDeletions = deletions.length;
    } else {
      // Non-interactive (hooks, automation) — skip deletions for safety
      skippedDeletions = deletions.length;
    }
  }

  let pulled = 0;
  let deleted = 0;

  // Handle deletions
  for (const change of changes) {
    if (change.type !== 'deleted') continue;
    if (!executeDeletions) continue;
    const fullPath = join(root, change.path);
    try { unlinkSync(fullPath); } catch { /* already gone */ }
    deleted++;
    pulled++;
  }

  // Download all added/modified/conflict-accepted files in a single tar request.
  // Conflicts are only included when the user explicitly chose "take remote".
  const downloads = changes.filter(c =>
    c.type === 'added' || c.type === 'modified' ||
    (c.type === 'conflict' && pullOverrides.has(c.path))
  );
  const writtenHashes = new Map<string, string>();
  if (downloads.length > 0) {
    const allFiles = await downloadAllFiles(config.projectGuid);
    for (const change of downloads) {
      const bytes = allFiles.get(change.path);
      if (!bytes) continue;
      const fullPath = join(root, change.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, bytes);
      writtenHashes.set(change.path, createHash('sha256').update(bytes).digest('hex'));
      pulled++;
    }
  }

  // Delete local directories that no longer exist on the remote (deepest first).
  // The tree manifest only returns files (not dirs), so derive dir paths from file paths.
  if (executeDeletions) {
    const remoteDirSet = new Set<string>();
    for (const rf of remoteFiles) {
      let p = rf.path;
      while (true) {
        const slash = p.lastIndexOf('/');
        if (slash <= 0) break;
        p = p.substring(0, slash);
        if (remoteDirSet.has(p)) break;
        remoteDirSet.add(p);
      }
    }
    const localDirs: string[] = [];

    function collectDirs(dir: string) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = join(dir, entry.name);
        const relPath = relative(root, fullPath).replace(/\\/g, '/');
        if (shouldIgnore(relPath, config.ignore)) continue;
        localDirs.push(relPath);
        collectDirs(fullPath);
      }
    }
    collectDirs(root);

    // Sort deepest first so children are deleted before parents
    localDirs.sort((a, b) => b.split('/').length - a.split('/').length);

    for (const dirPath of localDirs) {
      if (!remoteDirSet.has(dirPath)) {
        const fullPath = join(root, dirPath);
        try {
          rmdirSync(fullPath);  // only succeeds if empty
          deleted++;
        } catch {
          // not empty or already gone — skip
        }
      }
    }
  }

  // Update sync state. Seed the walk baseline with known hashes — pre-existing
  // hashes we had on entry plus hashes of anything we just wrote — so the new
  // baseline carries sha256 for every unchanged file without re-hashing.
  const postBaseline: Record<string, BaselineEntry> = {};
  for (const [path, info] of localFiles) {
    if (info.sha256) postBaseline[path] = { size: info.size, modified: info.modified, sha256: info.sha256 };
  }
  for (const [path, sha256] of writtenHashes) {
    try {
      const stat = statSync(join(root, path));
      postBaseline[path] = { size: stat.size, modified: stat.mtime.toISOString(), sha256 };
    } catch { /* file gone */ }
  }
  const updatedLocal = walkLocal(root, root, config.ignore, postBaseline);
  const stateFiles: Record<string, BaselineEntry> = {};
  for (const [path, info] of updatedLocal) {
    stateFiles[path] = info;
  }
  const now = new Date().toISOString();
  const state: SyncState = { lastSync: now, files: stateFiles };
  if (pulled > 0) {
    state.lastPull = { timestamp: now, count: pulled, summary: formatDiff(changes, 'down') };
  } else if (previousState.lastPull) {
    state.lastPull = previousState.lastPull;
  }
  saveSyncState(state);

  const summary = formatDiff(changes, 'down', state.lastPull);
  return { changes, pulled, pushed: 0, deleted, skippedDeletions, summary };
}

/** Sync up: push local changes to remote */
export async function syncUp(): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const remoteFiles = await fetchManifest(config.projectGuid);
  const baseline = loadSyncState().files;
  const localFiles = walkLocal(root, root, config.ignore, baseline);
  // Hash any local file whose remote has a hash, so sameContent() can use hashes.
  const remoteWithHash = remoteFiles.filter(f => f.type === 'file' && f.contentHash).map(f => f.path);
  await ensureLocalHashes(root, localFiles, remoteWithHash);
  const changes = diffManifest(remoteFiles, localFiles, 'up', baseline);

  let pushed = 0;

  // Deletions go first, serially — they're cheap and order matters less.
  for (const change of changes) {
    if (change.type !== 'deleted') continue;
    try {
      await del(`/projects/${config.projectGuid}/files?path=${encodeURIComponent(change.path)}`);
      pushed++;
    } catch {
      // Remote file may already be gone
    }
  }

  // Uploads (added + modified) — every file goes through the presigned-S3
  // flow regardless of size or content type. Run up to UPLOAD_CONCURRENCY
  // in parallel.
  const uploads = changes.filter(c => c.type !== 'deleted');
  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(UPLOAD_CONCURRENCY, uploads.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= uploads.length) return;
        const change = uploads[idx];
        const fullPath = join(root, change.path);
        await uploadOneFile(config.projectGuid, fullPath, change.path);
        pushed++;
      }
    })());
  }
  await Promise.all(workers);

  // Delete remote directories that no longer exist locally (shallowest first, recursive).
  // The tree manifest only returns files (not dirs), so derive dir paths from file paths.
  let deleted = 0;
  const remoteDirPaths = new Set<string>();
  for (const rf of remoteFiles) {
    let p = rf.path;
    while (true) {
      const slash = p.lastIndexOf('/');
      if (slash <= 0) break;
      p = p.substring(0, slash);
      if (remoteDirPaths.has(p)) break;
      remoteDirPaths.add(p);
    }
  }

  // Sort shallowest first so recursive deletes cover children
  const sortedDirs = [...remoteDirPaths].sort((a, b) => a.length - b.length);
  const deletedDirs = new Set<string>();
  for (const dirPath of sortedDirs) {
    if ([...deletedDirs].some(d => dirPath.startsWith(d + '/'))) continue;
    const localPath = join(root, dirPath);
    if (!existsSync(localPath)) {
      try {
        await del(`/projects/${config.projectGuid}/files?path=${encodeURIComponent(dirPath)}`);
        deletedDirs.add(dirPath);
        deleted++;
        pushed++;
      } catch {
        // already gone
      }
    }
  }

  // Update sync state. Use current localFiles as baseline seed — its hashes
  // reflect both pre-existing cached hashes and anything we just hashed for upload
  // (any local path present in `uploads` was hashed via the upload flow).
  const postBaseline: Record<string, BaselineEntry> = {};
  for (const [path, info] of localFiles) {
    if (info.sha256) postBaseline[path] = { size: info.size, modified: info.modified, sha256: info.sha256 };
  }
  const updatedLocal = walkLocal(root, root, config.ignore, postBaseline);
  const stateFiles: Record<string, BaselineEntry> = {};
  for (const [path, info] of updatedLocal) {
    stateFiles[path] = info;
  }
  saveSyncState({ lastSync: new Date().toISOString(), files: stateFiles });

  const summary = formatDiff(changes, 'up');
  return { changes, pushed, pulled: 0, deleted, skippedDeletions: 0, summary };
}

/** Check for changes without pulling/pushing */
export async function syncCheck(): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const remoteFiles = await fetchManifest(config.projectGuid);
  const baseline = loadSyncState().files;
  const localFiles = walkLocal(root, root, config.ignore, baseline);
  // Hash any local file where remote has a hash and we don't yet have a cached one,
  // so size-match-different-content is detected instead of silently passing.
  const toHash: string[] = [];
  for (const rf of remoteFiles) {
    if (rf.type !== 'file' || !rf.contentHash) continue;
    const local = localFiles.get(rf.path);
    if (local && !local.sha256) toHash.push(rf.path);
  }
  await ensureLocalHashes(root, localFiles, toHash);

  const downChanges = diffManifest(remoteFiles, localFiles, 'down', baseline);
  const summary = formatDiff(downChanges, 'down');

  return { changes: downChanges, pulled: 0, pushed: 0, deleted: 0, skippedDeletions: 0, summary };
}

/** Push a single file to remote */
export async function pushFile(filePath: string): Promise<void> {
  const config = requireConfig();
  const root = projectDir();
  const relPath = relative(root, filePath).replace(/\\/g, '/');

  if (shouldIgnore(relPath, config.ignore)) return;

  await uploadOneFile(config.projectGuid, filePath, relPath);
}

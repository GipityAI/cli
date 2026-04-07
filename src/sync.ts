import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, readdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import { get, put, del, download } from './api.js';
import { requireConfig, shouldIgnore, getConfigPath } from './config.js';
import { isBinaryFile, formatSize, prompt } from './utils.js';

interface RemoteFile {
  path: string;
  size: number;
  modified: string;
  type: string;
  guid: string;
}

interface SyncState {
  lastSync: string;
  files: Record<string, { size: number; modified: string }>;
}

export interface SyncChange {
  type: 'added' | 'modified' | 'deleted';
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

/** Walk local directory, returning relative paths and sizes */
function walkLocal(dir: string, base: string, ignorePatterns: string[]): Map<string, { size: number; modified: string }> {
  const result = new Map<string, { size: number; modified: string }>();

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
          result.set(relPath, {
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return result;
}

/** Fetch remote file manifest */
async function fetchManifest(projectGuid: string, prefix?: string): Promise<RemoteFile[]> {
  const query = prefix ? `?path=${encodeURIComponent(prefix)}` : '';
  const res = await get<{ data: RemoteFile[] }>(`/projects/${projectGuid}/files/tree${query}`);
  return res.data;
}

/** Compare remote manifest against local files, detect changes */
export function diffManifest(
  remoteFiles: RemoteFile[],
  localFiles: Map<string, { size: number; modified: string }>,
  direction: 'down' | 'up',
): SyncChange[] {
  const changes: SyncChange[] = [];

  if (direction === 'down') {
    // Detect remote changes: added/modified remotely, deleted remotely
    const remoteMap = new Map(remoteFiles.filter(f => f.type === 'file').map(f => [f.path, f]));

    for (const [path, remote] of remoteMap) {
      const local = localFiles.get(path);
      if (!local) {
        changes.push({ type: 'added', path, remoteSize: remote.size });
      } else if (local.size !== remote.size) {
        changes.push({ type: 'modified', path, localSize: local.size, remoteSize: remote.size });
      }
    }

    // Files that exist locally but not remotely → deleted remotely
    for (const [path] of localFiles) {
      if (!remoteMap.has(path)) {
        changes.push({ type: 'deleted', path, localSize: localFiles.get(path)!.size });
      }
    }
  } else {
    // Detect local changes: added/modified locally, deleted locally
    const remoteMap = new Map(remoteFiles.filter(f => f.type === 'file').map(f => [f.path, f]));

    for (const [path, local] of localFiles) {
      const remote = remoteMap.get(path);
      if (!remote) {
        changes.push({ type: 'added', path, localSize: local.size });
      } else if (local.size !== remote.size) {
        changes.push({ type: 'modified', path, localSize: local.size, remoteSize: remote.size });
      }
    }

    // Files that exist remotely but not locally → deleted locally
    for (const [path, remote] of remoteMap) {
      if (!localFiles.has(path)) {
        changes.push({ type: 'deleted', path, remoteSize: remote.size });
      }
    }
  }

  return changes;
}

export function formatDiff(changes: SyncChange[], direction: 'down' | 'up'): string {
  if (changes.length === 0) return 'No changes detected.';

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
    }
  }

  return lines.join('\n');
}

/** Confirm file deletions with the user. Returns true if deletions should proceed. */
async function confirmFileDeletions(deletions: SyncChange[]): Promise<boolean> {
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
  const localFiles = walkLocal(root, root, config.ignore);
  const changes = diffManifest(remoteFiles, localFiles, 'down');

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

  const remoteByPath = new Map(remoteFiles.filter(f => f.type === 'file').map(f => [f.path, f]));

  let pulled = 0;
  let deleted = 0;
  for (const change of changes) {
    if (change.type === 'deleted') {
      if (!executeDeletions) continue;
      const fullPath = join(root, change.path);
      try { unlinkSync(fullPath); } catch { /* already gone */ }
      deleted++;
      pulled++;
      continue;
    }

    // added or modified — download raw bytes from VFS
    const remoteFile = remoteByPath.get(change.path);
    if (!remoteFile) continue;
    const bytes = await download(`/files/vfs/${remoteFile.guid}`);
    const fullPath = join(root, change.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, bytes);
    pulled++;
  }

  // Update sync state
  const updatedLocal = walkLocal(root, root, config.ignore);
  const stateFiles: Record<string, { size: number; modified: string }> = {};
  for (const [path, info] of updatedLocal) {
    stateFiles[path] = info;
  }
  saveSyncState({ lastSync: new Date().toISOString(), files: stateFiles });

  const summary = formatDiff(changes, 'down');
  return { changes, pulled, pushed: 0, deleted, skippedDeletions, summary };
}

/** Sync up: push local changes to remote */
export async function syncUp(): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const remoteFiles = await fetchManifest(config.projectGuid);
  const localFiles = walkLocal(root, root, config.ignore);
  const changes = diffManifest(remoteFiles, localFiles, 'up');

  let pushed = 0;
  for (const change of changes) {
    if (change.type === 'deleted') {
      // File deleted locally — delete on remote
      try {
        await del(`/projects/${config.projectGuid}/files?path=${encodeURIComponent(change.path)}`);
        pushed++;
      } catch {
        // Remote file may already be gone
      }
      continue;
    }

    // added or modified — push to remote (skip binary files)
    const fullPath = join(root, change.path);
    const raw = readFileSync(fullPath);
    if (isBinaryFile(raw)) continue;
    const content = raw.toString('utf-8');
    await put(`/projects/${config.projectGuid}/files`, { path: change.path, content });
    pushed++;
  }

  // Delete remote directories that no longer exist locally (shallowest first, recursive)
  let deleted = 0;
  const remoteDirs = remoteFiles
    .filter(f => f.type === 'dir')
    .map(f => f.path)
    .sort((a, b) => a.length - b.length);

  const deletedDirs = new Set<string>();
  for (const dirPath of remoteDirs) {
    // Skip if a parent was already deleted (recursive delete covers children)
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

  // Update sync state
  const updatedLocal = walkLocal(root, root, config.ignore);
  const stateFiles: Record<string, { size: number; modified: string }> = {};
  for (const [path, info] of updatedLocal) {
    stateFiles[path] = info;
  }
  saveSyncState({ lastSync: new Date().toISOString(), files: stateFiles });

  const summary = formatDiff(changes.filter(c => c.type !== 'deleted'), 'up');
  return { changes, pushed, pulled: 0, deleted, skippedDeletions: 0, summary };
}

/** Check for changes without pulling/pushing */
export async function syncCheck(): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const remoteFiles = await fetchManifest(config.projectGuid);
  const localFiles = walkLocal(root, root, config.ignore);

  const downChanges = diffManifest(remoteFiles, localFiles, 'down');
  const summary = formatDiff(downChanges, 'down');

  return { changes: downChanges, pulled: 0, pushed: 0, deleted: 0, skippedDeletions: 0, summary };
}

/** Push a single file to remote */
export async function pushFile(filePath: string): Promise<void> {
  const config = requireConfig();
  const root = projectDir();
  const relPath = relative(root, filePath).replace(/\\/g, '/');

  if (shouldIgnore(relPath, config.ignore)) return;

  const raw = readFileSync(filePath);
  if (isBinaryFile(raw)) return;
  const content = raw.toString('utf-8');
  await put(`/projects/${config.projectGuid}/files`, { path: relPath, content });
}

/**
 * Multi-client-safe file sync between the local project directory and the VFS.
 *
 * Model: one unified plan/apply against a persisted baseline.
 *
 *   baseline  = the state both sides agreed on at the end of the last sync
 *               (stored at .gipity/sync-state.json - per-path {size, mtime,
 *               sha256, serverVersion})
 *   local     = what's on disk now
 *   remote    = what the server reports in /files/tree
 *
 * Each path is classified on each side independently (unchanged | modified |
 * added | deleted | absent), then a 9-cell decision table emits one Action
 * per path. The apply phase runs writes first, then deletes (both guarded
 * by the large-deletion threshold), with CAS on every upload/delete so
 * concurrent writers can't silently overwrite each other. A 409 from the
 * server triggers a targeted re-plan that downgrades the path to a
 * conflicted-copy rename.
 *
 * Conflict policy: remote wins the canonical path; local is renamed to
 * `name (conflict from <host> YYYY-MM-DD-HHMMSS).ext` and then uploaded on
 * the next pass so every client sees it. No content merging, ever.
 */
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, readdirSync, rmdirSync, readFileSync, renameSync, openSync, closeSync } from 'fs';
import { join, relative, dirname, extname } from 'path';
import { hostname } from 'os';
import { get, del, downloadStream, ApiError } from './api.js';
import { requireConfig, shouldIgnore, getConfigPath } from './config.js';
import { formatSize, prompt, getAutoConfirm } from './utils.js';
import { uploadOneFile, hashFile, UploadConflictError } from './upload.js';
import { DEFAULT_SYNC_IGNORE } from './setup.js';
import type { ProgressReporter } from './progress.js';

const CONFIG_FILE = '.gipity.json';
import * as tar from 'tar-stream';

// ─── Tunables ──────────────────────────────────────────────────

/** Apply a "bulk delete" guard when a plan deletes this many files AND this
 *  fraction of the known tree. Both thresholds must trip - one large
 *  deletion in a small project isn't noise, and many deletions in a huge
 *  project probably are intentional. */
const BULK_DELETE_COUNT = 10;
const BULK_DELETE_FRACTION = 0.25;

const UPLOAD_CONCURRENCY = 4;

// ─── Types ─────────────────────────────────────────────────────

export interface BaselineEntry {
  size: number;
  mtime: string;
  sha256: string;
  serverVersion: number;
}

export interface Baseline {
  projectGuid: string;
  files: Record<string, BaselineEntry>;
  lastFullSync: string | null;
}

interface LocalFileInfo {
  size: number;
  mtime: string;
  sha256?: string;
}

interface RemoteFileInfo {
  path: string;
  size: number;
  sha256: string | null;
  serverVersion: number;
  modified: string;
}

type Side = 'unchanged' | 'modified' | 'added' | 'deleted' | 'absent';

export type ActionKind =
  | 'upload'            // local → remote (new or modified)
  | 'download'          // remote → local (new or modified)
  | 'delete-local'      // remove from local filesystem
  | 'delete-remote'     // soft-delete on server
  | 'conflict';         // rename local + download remote + upload renamed copy

export interface Action {
  path: string;
  kind: ActionKind;
  localSize?: number;
  remoteSize?: number;
  /** CAS token to send: number (expected existing version) or null (expected new) or undefined (no CAS). */
  expectedServerVersion?: number | null;
  /** For conflict actions: the path the local file was renamed to. */
  renamedLocalTo?: string;
  reason?: string;
}

export interface PlanSummary {
  actions: Action[];
  uploads: number;
  downloads: number;
  deletesLocal: number;
  deletesRemote: number;
  conflicts: number;
}

export interface SyncOptions {
  /** Dry-run: print the plan and exit without applying. */
  plan?: boolean;
  /** Bypass the bulk-delete guard. */
  force?: boolean;
  /** Allow interactive prompts (guard confirmation). Defaults to TTY-detected. */
  interactive?: boolean;
  /** Optional progress reporter. Drives phase lines at each major step (scan,
   *  remote check, hashing, download) and a determinate byte bar during upload,
   *  so a long sync of a large tree doesn't read as a hang. Omit for silence. */
  progress?: ProgressReporter;
}

export interface SyncResult {
  plan: PlanSummary;
  applied: number;
  skipped: number;
  errors: string[];
  summary: string;
}

// ─── Paths ─────────────────────────────────────────────────────

function syncStatePath(): string {
  const configPath = getConfigPath()!;
  return join(dirname(configPath), '.gipity', 'sync-state.json');
}

function lockPath(): string {
  const configPath = getConfigPath()!;
  return join(dirname(configPath), '.gipity', 'sync.lock');
}

function projectDir(): string {
  const configPath = getConfigPath()!;
  return dirname(configPath);
}

// ─── Advisory lock ─────────────────────────────────────────────

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 500;

/** Acquire the per-project sync lock. Returns a release function. Exported for tests. */
export async function acquireLock(): Promise<() => void> {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* already gone */ } };
    } catch {
      // Either lock exists, or the race gave us a transient error. Check for
      // staleness (holder PID is dead → treat as unlocked).
      try {
        const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
        if (pid && !isNaN(pid)) {
          try { process.kill(pid, 0); }
          catch { try { unlinkSync(path); } catch { /* race */ } continue; }
        }
      } catch { /* couldn't read - retry */ }

      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error(
          `Another sync is in progress (${path}). Waited ${LOCK_WAIT_MS / 1000}s. ` +
          `Remove the file manually if you're sure no sync is running.`,
        );
      }
      await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

// ─── Baseline I/O ──────────────────────────────────────────────

export function readBaseline(projectGuid: string): Baseline {
  const path = syncStatePath();
  if (!existsSync(path)) return { projectGuid, files: {}, lastFullSync: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Baseline>;
    if (parsed.projectGuid !== projectGuid) {
      // Different project in this folder - baseline is not ours, treat as empty.
      return { projectGuid, files: {}, lastFullSync: null };
    }
    return {
      projectGuid,
      files: parsed.files ?? {},
      lastFullSync: parsed.lastFullSync ?? null,
    };
  } catch {
    return { projectGuid, files: {}, lastFullSync: null };
  }
}

export function writeBaseline(b: Baseline): void {
  const path = syncStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(b, null, 2));
}

// ─── Local walk ────────────────────────────────────────────────

export function walkLocal(
  root: string,
  ignorePatterns: string[],
  baseline: Record<string, BaselineEntry>,
): Map<string, LocalFileInfo> {
  const result = new Map<string, LocalFileInfo>();

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, '/');
      if (shouldIgnore(rel, ignorePatterns)) continue;
      if (entry.isDirectory()) {
        // Nested-project boundary: a subdirectory carrying its own
        // `.gipity.json` is a separate Gipity project that syncs itself.
        // Don't descend - a parent project must never scoop up the files
        // of a child project nested inside it.
        if (existsSync(join(full, CONFIG_FILE))) continue;
        walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          const size = stat.size;
          const mtime = stat.mtime.toISOString();
          const prior = baseline[rel];
          // Reuse cached hash when size+mtime haven't moved - avoids rehashing
          // the entire tree on every sync.
          const sha256 = prior && prior.size === size && prior.mtime === mtime
            ? prior.sha256 : undefined;
          result.set(rel, { size, mtime, sha256 });
        } catch { /* skip unreadable */ }
      }
    }
  }

  walk(root);
  return result;
}

async function ensureLocalHashes(
  root: string, local: Map<string, LocalFileInfo>, paths: Iterable<string>,
): Promise<void> {
  for (const path of paths) {
    const info = local.get(path);
    if (!info || info.sha256) continue;
    try {
      const { sha256 } = await hashFile(join(root, path));
      info.sha256 = sha256;
    } catch { /* skip */ }
  }
}

// ─── Remote fetch ──────────────────────────────────────────────

interface RemoteFileRaw {
  path: string;
  size: number;
  modified: string;
  type: string;
  guid: string;
  contentHash: string | null;
  serverVersion: number;
}

async function fetchRemote(projectGuid: string): Promise<Map<string, RemoteFileInfo>> {
  const res = await get<{ data: RemoteFileRaw[] }>(`/projects/${projectGuid}/files/tree`);
  const out = new Map<string, RemoteFileInfo>();
  for (const f of res.data) {
    if (f.type !== 'file') continue;
    out.set(f.path, {
      path: f.path,
      size: f.size,
      sha256: f.contentHash,
      serverVersion: f.serverVersion,
      modified: f.modified,
    });
  }
  return out;
}

async function downloadAll(
  projectGuid: string,
  onBytes?: (delta: number) => void,
): Promise<Map<string, Buffer>> {
  const stream = await downloadStream(`/projects/${projectGuid}/files/tree?content=tar`);
  const extract = tar.extract();
  const files = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    extract.on('entry', (header, entryStream, next) => {
      const chunks: Buffer[] = [];
      entryStream.on('data', (c: Buffer) => { chunks.push(c); onBytes?.(c.length); });
      entryStream.on('end', () => { files.set(header.name, Buffer.concat(chunks)); next(); });
      entryStream.resume();
    });
    extract.on('finish', () => resolve(files));
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

async function fetchOne(projectGuid: string, path: string): Promise<Buffer | null> {
  try {
    const stream = await downloadStream(
      `/projects/${projectGuid}/files/tree?content=tar&path=${encodeURIComponent(path)}`,
    );
    const extract = tar.extract();
    return await new Promise<Buffer | null>((resolve, reject) => {
      let found: Buffer | null = null;
      extract.on('entry', (header, entryStream, next) => {
        if (header.name === path) {
          const chunks: Buffer[] = [];
          entryStream.on('data', (c: Buffer) => chunks.push(c));
          entryStream.on('end', () => { found = Buffer.concat(chunks); next(); });
        } else {
          entryStream.on('end', () => next());
        }
        entryStream.resume();
      });
      extract.on('finish', () => resolve(found));
      extract.on('error', reject);
      stream.pipe(extract);
    });
  } catch {
    return null;
  }
}

// ─── Classification ────────────────────────────────────────────

function classifyLocal(info: LocalFileInfo | undefined, base: BaselineEntry | undefined): Side {
  if (!info && !base) return 'absent';
  if (!info && base) return 'deleted';
  if (info && !base) return 'added';
  // Both present: compare sha256 if available, else fall back to size.
  const iSha = info!.sha256;
  const bSha = base!.sha256;
  if (iSha && bSha) return iSha === bSha ? 'unchanged' : 'modified';
  return info!.size === base!.size ? 'unchanged' : 'modified';
}

function classifyRemote(info: RemoteFileInfo | undefined, base: BaselineEntry | undefined): Side {
  if (!info && !base) return 'absent';
  if (!info && base) return 'deleted';
  if (info && !base) return 'added';
  const iSha = info!.sha256;
  const bSha = base!.sha256;
  if (iSha && bSha) return iSha === bSha ? 'unchanged' : 'modified';
  return info!.size === base!.size ? 'unchanged' : 'modified';
}

// ─── Conflicted-copy names ────────────────────────────────────

/** Exported for tests. */
export function conflictedCopyName(path: string): string {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = extname(path);
  const base = ext ? path.slice(0, -ext.length) : path;
  return `${base} (conflict from ${host} ${ts})${ext}`;
}

// ─── Plan ─────────────────────────────────────────────────────

export function plan(
  local: Map<string, LocalFileInfo>,
  remote: Map<string, RemoteFileInfo>,
  baseline: Record<string, BaselineEntry>,
): PlanSummary {
  const actions: Action[] = [];
  const allPaths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(baseline)]);

  for (const path of allPaths) {
    const L = local.get(path);
    const R = remote.get(path);
    const B = baseline[path];
    const lSide = classifyLocal(L, B);
    const rSide = classifyRemote(R, B);

    // absent × absent: baseline may have had it as stale; if also absent, skip.
    if (lSide === 'absent' && rSide === 'absent') continue;

    // Content match (both sides have current sha and they agree) → adopt, noop.
    const shasMatch = L?.sha256 && R?.sha256 && L.sha256 === R.sha256;

    // absent × added → download (remote has a file we never had)
    if (lSide === 'absent' && rSide === 'added') {
      actions.push({ path, kind: 'download', remoteSize: R!.size });
      continue;
    }
    // added × absent → upload new
    if (lSide === 'added' && rSide === 'absent') {
      actions.push({ path, kind: 'upload', localSize: L!.size, expectedServerVersion: null });
      continue;
    }
    // unchanged × unchanged → noop
    if (lSide === 'unchanged' && rSide === 'unchanged') continue;
    // unchanged × modified → download, but ONLY if the remote genuinely advanced.
    // Guards a read-after-write race: right after a local write+push, the push can
    // advance the local baseline to the new version while the remote tree API still
    // serves the OLD bytes (stale read). That makes remote look "modified" vs an
    // already-updated baseline, and a blind download would silently clobber the
    // just-written local file with a stale older version. A real remote change
    // always carries a strictly newer serverVersion; an equal/older one is stale.
    if (lSide === 'unchanged' && rSide === 'modified') {
      if (B && R!.serverVersion <= B.serverVersion) continue;
      actions.push({ path, kind: 'download', remoteSize: R!.size });
      continue;
    }
    // unchanged × deleted → delete-local
    if (lSide === 'unchanged' && rSide === 'deleted') {
      actions.push({ path, kind: 'delete-local', localSize: L!.size });
      continue;
    }
    // modified × unchanged → upload (CAS against baseline)
    if (lSide === 'modified' && rSide === 'unchanged') {
      actions.push({ path, kind: 'upload', localSize: L!.size, expectedServerVersion: B!.serverVersion });
      continue;
    }
    // modified × modified → conflict (or noop if content happens to match)
    if (lSide === 'modified' && rSide === 'modified') {
      if (shasMatch) continue;
      actions.push({
        path, kind: 'conflict',
        localSize: L!.size, remoteSize: R!.size,
        renamedLocalTo: conflictedCopyName(path),
        expectedServerVersion: B!.serverVersion,
        reason: 'both sides modified since last sync',
      });
      continue;
    }
    // modified × deleted → re-upload local as new file (remote thinks it's gone)
    if (lSide === 'modified' && rSide === 'deleted') {
      actions.push({
        path, kind: 'upload', localSize: L!.size, expectedServerVersion: null,
        reason: 'remote deleted, local modified - preserving local edit',
      });
      continue;
    }
    // added × added → noop if shas match, else conflict
    if (lSide === 'added' && rSide === 'added') {
      if (shasMatch) continue;
      actions.push({
        path, kind: 'conflict',
        localSize: L!.size, remoteSize: R!.size,
        renamedLocalTo: conflictedCopyName(path),
        expectedServerVersion: null,
        reason: 'both sides created the same path with different content',
      });
      continue;
    }
    // deleted × absent → baseline is stale, drop it silently (no action)
    if (lSide === 'deleted' && rSide === 'absent') continue;
    // deleted × unchanged → delete remote
    if (lSide === 'deleted' && rSide === 'unchanged') {
      actions.push({ path, kind: 'delete-remote', remoteSize: R!.size, expectedServerVersion: B!.serverVersion });
      continue;
    }
    // deleted × modified → remote wins, restore locally — but only if the remote
    // actually advanced past the baseline. A stale (older/equal) remote read must
    // not resurrect a file the user intentionally deleted.
    if (lSide === 'deleted' && rSide === 'modified') {
      if (B && R!.serverVersion <= B.serverVersion) continue;
      actions.push({
        path, kind: 'download', remoteSize: R!.size,
        reason: 'local deleted but remote modified - remote preserved',
      });
      continue;
    }
    // deleted × deleted → noop, drop baseline
    if (lSide === 'deleted' && rSide === 'deleted') continue;

    // Remaining combinations are impossible given baseline semantics.
  }

  const uploads = actions.filter(a => a.kind === 'upload').length;
  const downloads = actions.filter(a => a.kind === 'download').length;
  const deletesLocal = actions.filter(a => a.kind === 'delete-local').length;
  const deletesRemote = actions.filter(a => a.kind === 'delete-remote').length;
  const conflicts = actions.filter(a => a.kind === 'conflict').length;

  return { actions, uploads, downloads, deletesLocal, deletesRemote, conflicts };
}

// ─── Apply ─────────────────────────────────────────────────────

function formatAction(a: Action): string {
  const size = a.remoteSize ?? a.localSize ?? 0;
  switch (a.kind) {
    case 'upload':       return `  ↑ ${a.path} (${formatSize(size)})`;
    case 'download':     return `  ↓ ${a.path} (${formatSize(size)})`;
    case 'delete-local': return `  − ${a.path}  [delete local]`;
    case 'delete-remote': return `  − ${a.path}  [delete remote]`;
    case 'conflict':     return `  ! ${a.path}  → ${a.renamedLocalTo}`;
  }
}

export function formatPlan(p: PlanSummary): string {
  if (p.actions.length === 0) return 'Up to date.';
  const lines: string[] = [];
  const parts: string[] = [];
  if (p.uploads) parts.push(`${p.uploads} upload${p.uploads > 1 ? 's' : ''}`);
  if (p.downloads) parts.push(`${p.downloads} download${p.downloads > 1 ? 's' : ''}`);
  if (p.deletesLocal) parts.push(`${p.deletesLocal} local delete${p.deletesLocal > 1 ? 's' : ''}`);
  if (p.deletesRemote) parts.push(`${p.deletesRemote} remote delete${p.deletesRemote > 1 ? 's' : ''}`);
  if (p.conflicts) parts.push(`${p.conflicts} conflict${p.conflicts > 1 ? 's' : ''}`);
  lines.push(parts.join(', ') + ':');
  for (const a of p.actions) lines.push(formatAction(a));
  return lines.join('\n');
}

async function bulkDeleteGuard(
  p: PlanSummary, knownFiles: number, opts: SyncOptions,
): Promise<boolean> {
  const totalDeletes = p.deletesLocal + p.deletesRemote;
  if (totalDeletes === 0) return true;
  if (opts.force) return true;
  const denom = Math.max(knownFiles, 1);
  const fraction = totalDeletes / denom;
  if (totalDeletes < BULK_DELETE_COUNT || fraction < BULK_DELETE_FRACTION) return true;

  if (!opts.interactive || getAutoConfirm()) {
    console.error(
      `Refusing to delete ${totalDeletes} file${totalDeletes > 1 ? 's' : ''} ` +
      `(${Math.round(fraction * 100)}% of tree) non-interactively. ` +
      `Re-run with --force or interactively to confirm.`,
    );
    return false;
  }
  const answer = await prompt(
    `\nPlan deletes ${totalDeletes} files (${Math.round(fraction * 100)}% of the tree). Type "delete" to confirm: `,
  );
  return answer.trim().toLowerCase() === 'delete';
}

async function applyUpload(
  projectGuid: string, root: string, a: Action,
  onConflict: (path: string, current: number | null) => Action,
): Promise<Action> {
  try {
    const result = await uploadOneFile(projectGuid, join(root, a.path), a.path, {
      expectedServerVersion: a.expectedServerVersion,
    });
    return { ...a, reason: `uploaded serverVersion=${result.serverVersion}` };
  } catch (err) {
    if (err instanceof UploadConflictError) {
      return onConflict(a.path, err.currentServerVersion);
    }
    throw err;
  }
}

export async function sync(opts: SyncOptions = {}): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const interactive = opts.interactive ?? process.stdout.isTTY ?? false;

  // A config written with an empty `ignore` (older projects, or one produced
  // by the one-off Home-fallback path) would make sync walk and hash the
  // entire tree - node_modules, .git, caches and all. Fall back to the
  // standard ignore set so an empty list never means "sync everything".
  const ignore = config.ignore && config.ignore.length
    ? config.ignore
    : [...DEFAULT_SYNC_IGNORE];

  const releaseLock = await acquireLock();
  try {
    return await syncInner(config.projectGuid, root, ignore, opts, interactive);
  } finally {
    releaseLock();
  }
}

async function syncInner(
  projectGuid: string, root: string, ignore: string[],
  opts: SyncOptions, interactive: boolean,
): Promise<SyncResult> {
  // Shadow `config` locally so the rest of the function keeps its original
  // shape. The two fields we actually use are the ones we took as args.
  const config = { projectGuid, ignore };

  const p = opts.progress;

  const baseline = readBaseline(projectGuid);
  p?.phase('Scanning local files…');
  const local = walkLocal(root, ignore, baseline.files);
  p?.phase('Checking Gipity for changes…');
  const remote = await fetchRemote(projectGuid);

  // Hash everything we might classify ambiguously. Any local path also on
  // remote (and the remote has a hash) needs a local hash so size-match-but-
  // content-differs isn't misclassified. Anything in baseline that's still
  // local-present-remote-absent likewise needs its hash to classify correctly.
  const needHash: string[] = [];
  for (const [path, l] of local) {
    if (l.sha256) continue;
    const r = remote.get(path);
    if (r?.sha256 || baseline.files[path]) needHash.push(path);
  }
  if (needHash.length) p?.phase(`Hashing ${needHash.length} file${needHash.length === 1 ? '' : 's'}…`);
  await ensureLocalHashes(root, local, needHash);

  const planned = plan(local, remote, baseline.files);

  if (opts.plan) {
    return {
      plan: planned, applied: 0, skipped: 0, errors: [],
      summary: formatPlan(planned),
    };
  }

  // Bulk-delete guard over the *planned* deletes.
  const knownFiles = local.size + remote.size;
  const deletesOk = await bulkDeleteGuard(planned, knownFiles, { ...opts, interactive });

  // Filter actions based on guard
  const plannedToApply = deletesOk ? planned.actions : planned.actions.filter(
    a => a.kind !== 'delete-local' && a.kind !== 'delete-remote',
  );
  const skippedByGuard = planned.actions.length - plannedToApply.length;

  const errors: string[] = [];
  let applied = 0;

  // ── Pre-fetch remote bytes once for all downloads (conflict-originating
  //    remote versions are fetched on demand after 409). ──
  const downloadedBytes = new Map<string, Buffer>();
  const needsBulkDownload = plannedToApply.some(a => a.kind === 'download' || a.kind === 'conflict');
  if (needsBulkDownload) {
    // The tree endpoint streams the *whole* remote tree as one tar (the caller
    // then picks out only the paths it planned to apply), so the bytes that
    // actually move = the sum of every remote file's size. That's the honest
    // denominator for the bar - it tracks real wire progress, not just the
    // handful of changed files.
    const downloadLabel = 'Downloading updates from Gipity';
    const totalDownloadBytes = [...remote.values()].reduce((sum, r) => sum + r.size, 0);
    let recvBytes = 0;
    p?.transfer(downloadLabel, 0, totalDownloadBytes);
    const onBytes = p
      ? (delta: number) => {
          recvBytes = Math.min(recvBytes + delta, totalDownloadBytes);
          p.transfer(downloadLabel, recvBytes, totalDownloadBytes);
        }
      : undefined;
    try {
      const all = await downloadAll(config.projectGuid, onBytes);
      for (const a of plannedToApply) {
        if (a.kind === 'download' || a.kind === 'conflict') {
          const buf = all.get(a.path);
          if (buf) downloadedBytes.set(a.path, buf);
        }
      }
    } catch (err) {
      errors.push(`Download batch failed: ${(err as Error).message}`);
    } finally {
      // Settle the bar even if the extracted-byte tally fell short of the
      // estimate (the live line stays open until something hits 100% or finish()).
      p?.finish();
    }
  }

  // ── Writes pass: uploads, downloads, conflicts (rename + download + upload copy) ──
  // We serialize conflicts; uploads run with bounded concurrency.
  const uploadQueue: Action[] = plannedToApply.filter(a => a.kind === 'upload');
  const downloadQueue: Action[] = plannedToApply.filter(a => a.kind === 'download');
  const conflictQueue: Action[] = plannedToApply.filter(a => a.kind === 'conflict');

  // Handle downloads first (no network writes) - fills local fs with remote changes.
  for (const a of downloadQueue) {
    const buf = downloadedBytes.get(a.path);
    if (!buf) {
      errors.push(`Download missing: ${a.path}`);
      continue;
    }
    const full = join(root, a.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buf);
    const stat = statSync(full);
    local.set(a.path, { size: stat.size, mtime: stat.mtime.toISOString(), sha256: undefined });
    baseline.files[a.path] = {
      size: stat.size, mtime: stat.mtime.toISOString(),
      sha256: remote.get(a.path)!.sha256 ?? '',
      serverVersion: remote.get(a.path)!.serverVersion,
    };
    applied++;
  }

  // Conflicts: rename local copy, overwrite original path with remote, then
  // upload the renamed copy. If the upload of the renamed copy fails, we
  // still keep the rename on disk - next sync picks it up as "added".
  for (const a of conflictQueue) {
    const full = join(root, a.path);
    const renamed = join(root, a.renamedLocalTo!);
    try {
      mkdirSync(dirname(renamed), { recursive: true });
      renameSync(full, renamed);
    } catch (err) {
      errors.push(`Could not rename ${a.path} → ${a.renamedLocalTo}: ${(err as Error).message}`);
      continue;
    }

    const buf = downloadedBytes.get(a.path);
    if (buf) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, buf);
      const stat = statSync(full);
      baseline.files[a.path] = {
        size: stat.size, mtime: stat.mtime.toISOString(),
        sha256: remote.get(a.path)!.sha256 ?? '',
        serverVersion: remote.get(a.path)!.serverVersion,
      };
    } else {
      errors.push(`Conflict: remote bytes missing for ${a.path}; local copy preserved at ${a.renamedLocalTo}`);
    }

    // Upload the renamed local copy as a brand-new path.
    try {
      const result = await uploadOneFile(config.projectGuid, renamed, a.renamedLocalTo!, {
        expectedServerVersion: null,
      });
      const stat = statSync(renamed);
      const { sha256 } = await hashFile(renamed);
      baseline.files[a.renamedLocalTo!] = {
        size: stat.size, mtime: stat.mtime.toISOString(),
        sha256, serverVersion: result.serverVersion,
      };
    } catch (err) {
      errors.push(`Could not upload conflict copy ${a.renamedLocalTo}: ${(err as Error).message}`);
    }
    applied++;
  }

  // Uploads: bounded concurrency. On 409, rewrite as a conflict inline.
  // A single byte bar tracks the whole batch (workers share the counter; JS is
  // single-threaded so the += is race-free).
  const uploadLabel = `Uploading ${uploadQueue.length} file${uploadQueue.length === 1 ? '' : 's'}`;
  const totalUploadBytes = uploadQueue.reduce((sum, a) => sum + (a.localSize ?? 0), 0);
  let sentBytes = 0;
  if (uploadQueue.length) p?.transfer(uploadLabel, 0, totalUploadBytes);
  const onBytes = p
    ? (delta: number) => { sentBytes += delta; p.transfer(uploadLabel, sentBytes, totalUploadBytes); }
    : undefined;
  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(UPLOAD_CONCURRENCY, uploadQueue.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= uploadQueue.length) return;
        const a = uploadQueue[idx];
        const full = join(root, a.path);
        try {
          const result = await uploadOneFile(config.projectGuid, full, a.path, {
            expectedServerVersion: a.expectedServerVersion,
            onBytes,
          });
          const stat = statSync(full);
          const { sha256 } = await hashFile(full);
          baseline.files[a.path] = {
            size: stat.size, mtime: stat.mtime.toISOString(),
            sha256, serverVersion: result.serverVersion,
          };
          applied++;
        } catch (err) {
          if (err instanceof UploadConflictError) {
            // Remote moved under us. Fetch the current remote bytes and
            // downgrade this path to a conflict: rename local, write remote,
            // re-upload the rename.
            const currentBytes = await fetchOne(config.projectGuid, a.path);
            const renamedRel = conflictedCopyName(a.path);
            try {
              renameSync(full, join(root, renamedRel));
            } catch (e) {
              errors.push(`Rename failed for ${a.path}: ${(e as Error).message}`);
              continue;
            }
            if (currentBytes) {
              mkdirSync(dirname(full), { recursive: true });
              writeFileSync(full, currentBytes);
              const stat = statSync(full);
              baseline.files[a.path] = {
                size: stat.size, mtime: stat.mtime.toISOString(),
                sha256: '',  // will re-hash on next sync
                serverVersion: err.currentServerVersion ?? 0,
              };
            }
            try {
              const result = await uploadOneFile(
                config.projectGuid, join(root, renamedRel), renamedRel,
                { expectedServerVersion: null },
              );
              const stat = statSync(join(root, renamedRel));
              const { sha256 } = await hashFile(join(root, renamedRel));
              baseline.files[renamedRel] = {
                size: stat.size, mtime: stat.mtime.toISOString(),
                sha256, serverVersion: result.serverVersion,
              };
            } catch (e) {
              errors.push(`Conflict-copy upload failed for ${renamedRel}: ${(e as Error).message}`);
            }
            applied++;
          } else {
            errors.push(`Upload failed for ${a.path}: ${(err as Error).message}`);
          }
        }
      }
    })());
  }
  await Promise.all(workers);

  // ── Deletes pass ──
  for (const a of plannedToApply) {
    if (a.kind === 'delete-local') {
      try {
        unlinkSync(join(root, a.path));
      } catch { /* already gone */ }
      delete baseline.files[a.path];
      applied++;
    } else if (a.kind === 'delete-remote') {
      try {
        const qs = `path=${encodeURIComponent(a.path)}` +
          (a.expectedServerVersion !== undefined && a.expectedServerVersion !== null
            ? `&expected_server_version=${a.expectedServerVersion}` : '');
        await del(`/projects/${config.projectGuid}/files?${qs}`);
        delete baseline.files[a.path];
        applied++;
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 409) {
          errors.push(`Could not delete ${a.path}: server has newer version - re-sync to resolve`);
        } else if (err instanceof ApiError && err.statusCode === 404) {
          // Already gone - drop from baseline.
          delete baseline.files[a.path];
          applied++;
        } else {
          errors.push(`Delete failed for ${a.path}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Clean up empty local directories after delete-local actions.
  cleanupEmptyDirs(root, config.ignore);

  baseline.lastFullSync = new Date().toISOString();
  writeBaseline(baseline);

  p?.finish();

  return {
    plan: planned,
    applied,
    skipped: skippedByGuard,
    errors,
    summary: formatPlan(planned),
  };
}

function cleanupEmptyDirs(root: string, ignorePatterns: string[]): void {
  function walk(dir: string): boolean {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return false; }
    let kept = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, '/');
      if (shouldIgnore(rel, ignorePatterns)) { kept++; continue; }
      if (entry.isDirectory()) {
        if (!walk(full)) kept++;
      } else {
        kept++;
      }
    }
    if (kept === 0 && dir !== root) {
      try { rmdirSync(dir); return true; } catch { return false; }
    }
    return false;
  }
  walk(root);
}

// ─── Single-file push (used by `gipity push <file>`) ───────────

export async function pushFile(filePath: string): Promise<void> {
  const config = requireConfig();
  const root = projectDir();
  const rel = relative(root, filePath).replace(/\\/g, '/');
  if (shouldIgnore(rel, config.ignore)) return;

  const baseline = readBaseline(config.projectGuid);
  const baseEntry = baseline.files[rel];
  try {
    const result = await uploadOneFile(config.projectGuid, filePath, rel, {
      expectedServerVersion: baseEntry ? baseEntry.serverVersion : null,
    });
    const stat = statSync(filePath);
    const { sha256 } = await hashFile(filePath);
    baseline.files[rel] = {
      size: stat.size, mtime: stat.mtime.toISOString(),
      sha256, serverVersion: result.serverVersion,
    };
    writeBaseline(baseline);
  } catch (err) {
    if (err instanceof UploadConflictError) {
      throw new Error(
        `${rel}: remote has a newer version (serverVersion=${err.currentServerVersion}). ` +
        `Run \`gipity sync\` first to reconcile.`,
      );
    }
    throw err;
  }
}

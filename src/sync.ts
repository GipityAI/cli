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
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, readdirSync, rmdirSync, readFileSync, renameSync, openSync, closeSync, utimesSync } from 'fs';
import { join, relative, dirname, extname, resolve, sep } from 'path';
import { hostname } from 'os';
import { get, del, downloadStream, ApiError } from './api.js';
import { requireConfig, shouldIgnore, getConfigPath } from './config.js';
import { formatSize, prompt, getAutoConfirm } from './utils.js';
import {
  uploadOneFile, hashFile, guessMime, transferToS3,
  uploadInitBatch, uploadCompleteBatch, UploadConflictError,
  UPLOAD_CONCURRENCY, UPLOAD_INIT_BATCH_SIZE,
  UPLOAD_MAX_BYTES, UPLOAD_MAX_PATH_CHARS,
  type BatchInitResult, type BatchCompleteItem,
} from './upload.js';
import { DEFAULT_SYNC_IGNORE } from './setup.js';
import type { ProgressReporter, SpinnerHandle } from './progress.js';

const CONFIG_FILE = '.gipity.json';
import * as tar from 'tar-stream';

// ─── Tunables ──────────────────────────────────────────────────

/** Apply a "bulk delete" guard when a plan deletes this many files AND this
 *  fraction of the known tree. Both thresholds must trip - one large
 *  deletion in a small project isn't noise, and many deletions in a huge
 *  project probably are intentional. */
const BULK_DELETE_COUNT = 10;
const BULK_DELETE_FRACTION = 0.25;

/** A tar download that stops producing bytes for this long - without ever
 *  ending the stream - is treated as a stall and aborted, so a wedged
 *  connection becomes a recoverable error instead of an unbounded hang. */
const DOWNLOAD_IDLE_MS = 30_000;

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
  /** Apply the bulk deletes the guard would otherwise defer (the deliberate
   *  cleanup path: `gipity sync --prune`). Same effect as `force` for deletes,
   *  named so the intent reads clearly at the call site. */
  prune?: boolean;
  /** Allow interactive prompts (guard confirmation). Defaults to TTY-detected. */
  interactive?: boolean;
  /** Opt in to the uncertain-merge confirmation: when opening a project INTO a
   *  directory that already holds files we've never synced for it (empty
   *  baseline + local content that would upload or collide), show the merge
   *  shape and ask before moving anything. Only the interactive open flow sets
   *  this - background syncs (deploy/test/sandbox/relay) and deliberate
   *  directory adoption (`gipity init`) merge without asking, as they always
   *  have. The check still no-ops unless there's a real first-time merge. */
  confirmMerge?: boolean;
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
  /** Count of delete actions the bulk-delete guard deferred (skipped) this run.
   *  Non-interactive callers (deploy/test/sandbox) defer silently; surface this
   *  where it's useful (e.g. `gipity sync` hints at `--prune`). */
  deferredDeletes: number;
  /** True when the user declined the uncertain-merge confirmation: nothing was
   *  applied, the directory is left exactly as it was. Callers should not treat
   *  this as a normal "synced" result. */
  aborted?: boolean;
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
// While a holder works it refreshes the lock's mtime on this cadence; a lock
// whose mtime is older than the stale window is treated as abandoned and
// reclaimed even if a process with its PID still exists. This catches the two
// cases a dead-PID check misses: a CPU-wedged holder that stopped heartbeating,
// and PID reuse (some unrelated process now owns the old holder's PID). The
// stale window must stay comfortably larger than the heartbeat so a briefly
// busy holder isn't robbed mid-run.
const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_STALE_MS = 90_000;

/** Decide whether an existing lock file is reclaimable. Exported for tests.
 *  Reclaim when: the file is empty/garbage (holder crashed between creating the
 *  lock and writing its PID), the holder PID is dead, or the lock's heartbeat
 *  went silent past {@link LOCK_STALE_MS}. A live, freshly-heartbeating holder
 *  is never reclaimed. */
export function isLockReclaimable(path: string, now = Date.now()): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, 'utf-8').trim();
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false; // can't read it (likely already gone / racing) - retry, don't steal
  }
  const pid = parseInt(raw, 10);
  if (!raw || !pid || isNaN(pid)) return true; // empty/garbage = crashed mid-create
  try { process.kill(pid, 0); }
  catch { return true; }                        // holder PID is dead
  return now - mtimeMs > LOCK_STALE_MS;          // alive but heartbeat went silent
}

/** Acquire the per-project sync lock. Returns a release function. Exported for tests.
 *  Pass `progress` so a *contended* wait (another sync/push holds the lock) shows a
 *  live "Waiting for another sync…" spinner instead of a silent stall - the lock is
 *  taken before any sync phase prints, so without this an agent or user staring at a
 *  frozen terminal can't tell a 30s lock wait from a genuine hang. The spinner is
 *  created lazily, only when we actually have to wait, so the common instant-acquire
 *  path stays output-free (and on a non-TTY the reporter is a no-op regardless). */
export async function acquireLock(progress?: ProgressReporter): Promise<() => void> {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  // Lazily-opened spinner for the contended case; settled before we return.
  let waitSpinner: SpinnerHandle | null = null;
  const settleWait = (ok: boolean) => {
    if (!waitSpinner) return;
    if (ok) waitSpinner.stop(); else waitSpinner.fail('Gave up waiting for the sync lock');
    waitSpinner = null;
  };
  while (true) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      // Heartbeat: keep the lock's mtime fresh so peers can distinguish a live
      // holder from an abandoned one. unref() so it never holds the process open.
      const beat = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()); } catch { /* lock gone */ }
      }, LOCK_HEARTBEAT_MS);
      beat.unref?.();
      settleWait(true);
      return () => { clearInterval(beat); try { unlinkSync(path); } catch { /* already gone */ } };
    } catch {
      // Lock exists (or the race gave a transient error). Reclaim it if the
      // holder is dead/abandoned; otherwise wait and retry.
      if (isLockReclaimable(path)) {
        try { unlinkSync(path); } catch { /* race - someone else got it */ }
        continue;
      }

      if (Date.now() - start > LOCK_WAIT_MS) {
        settleWait(false);
        throw new Error(
          `Another sync is in progress (${path}). Waited ${LOCK_WAIT_MS / 1000}s. ` +
          `Remove the file manually if you're sure no sync is running.`,
        );
      }
      // First time we're forced to wait: open the spinner so the wait is visible
      // (with an elapsed timer) rather than reading as a frozen process.
      if (!waitSpinner) {
        waitSpinner = progress?.spinner('Waiting for another sync to finish…') ?? null;
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

// Tree paths key everything: the remote listing, the tar entries, the local
// walk (which uses leading-slash-free `relative(root, …)`), and the baseline.
// Source files come back slash-free, but Storage/job-written objects (e.g.
// `/uploads/fl_…/clip.mp4`) are listed with a leading slash while their tar
// entry is slash-free - so a blind `all.get('/uploads/…')` misses and sync
// reports a freshly-pulled file as "Download missing", then re-plans it every
// run. Strip leading slashes at every boundary so all four keys agree.
function normalizeTreePath(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * Resolve a relative path against the project root and assert it stays inside.
 * Remote-supplied paths (the server's `/files/tree`, tar entry names, and the
 * conflict-rename targets derived from them) are untrusted: `normalizeTreePath`
 * strips a leading slash but NOT `..` segments, so a path like
 * `../../.ssh/authorized_keys` would otherwise resolve outside the project and
 * be written/renamed/deleted there. The relay daemon runs `sync` unattended on
 * every dispatch, so an unchecked traversal is arbitrary file write with no
 * human in the loop. Throws on escape; callers skip the offending action. */
export function resolveInRoot(root: string, relPath: string): string {
  const rootResolved = resolve(root);
  const full = resolve(rootResolved, relPath);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw new Error(`Refusing path outside project root: ${relPath}`);
  }
  return full;
}

async function fetchRemote(projectGuid: string): Promise<Map<string, RemoteFileInfo>> {
  const res = await get<{ data: RemoteFileRaw[] }>(`/projects/${projectGuid}/files/tree`);
  const out = new Map<string, RemoteFileInfo>();
  for (const f of res.data) {
    if (f.type !== 'file') continue;
    const path = normalizeTreePath(f.path);
    out.set(path, {
      path,
      size: f.size,
      sha256: f.contentHash,
      serverVersion: f.serverVersion,
      modified: f.modified,
    });
  }
  return out;
}

/**
 * Extract a tar stream into a path→bytes map, guarded by an idle watchdog.
 *
 * The sync hang was here: the server delivered every byte (progress bar hit
 * 100%) but never cleanly ended the stream, so tar's 'finish' never fired and
 * the awaiting Promise never settled - an unbounded hang. The watchdog turns
 * that into a recoverable error: if no bytes arrive for idleMs without the
 * stream ending, destroy it (closing the socket) and reject. pipe() also doesn't
 * forward source errors to the destination, so we reject on a source 'error' too
 * - a truncated body must never look like a clean 'finish' with partial files.
 *
 * `keep` filters which entries to buffer (default: all); every entry is still
 * drained so the stream can progress. Exported for tests.
 */
export function extractTarToMap(
  stream: import('stream').Readable,
  idleMs: number,
  onBytes?: (delta: number) => void,
  keep?: (path: string) => boolean,
): Promise<Map<string, Buffer>> {
  const extract = tar.extract();
  const files = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (settled) return;
        settled = true;
        const e = new Error(`download stalled: no data for ${idleMs / 1000}s`);
        stream.destroy(e);
        reject(e);
      }, idleMs);
      idle.unref?.();
    };
    const done = (fn: (v?: any) => void, arg?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      fn(arg);
    };
    extract.on('entry', (header, entryStream, next) => {
      arm();
      const name = normalizeTreePath(header.name);
      const wanted = keep ? keep(name) : true;
      const chunks: Buffer[] = [];
      entryStream.on('data', (c: Buffer) => { if (wanted) chunks.push(c); onBytes?.(c.length); arm(); });
      entryStream.on('end', () => { if (wanted) files.set(name, Buffer.concat(chunks)); next(); });
      entryStream.resume();
    });
    extract.on('finish', () => done(resolve, files));
    extract.on('error', (e) => done(reject, e));
    stream.on('error', (e) => done(reject, e));
    arm();
    stream.pipe(extract);
  });
}

async function downloadAll(
  projectGuid: string,
  onBytes?: (delta: number) => void,
): Promise<Map<string, Buffer>> {
  const stream = await downloadStream(`/projects/${projectGuid}/files/tree?content=tar`);
  return extractTarToMap(stream, DOWNLOAD_IDLE_MS, onBytes);
}

async function fetchOne(projectGuid: string, path: string): Promise<Buffer | null> {
  // Exact single-file read first. The tree-tar endpoint below treats its `path`
  // as a DIRECTORY prefix, so a single root file (e.g. `gipity.yaml`) comes back
  // empty — which silently broke conflict restores and trapped sync in an
  // unresolvable delete-vs-newer loop. `/files/read` is the exact-path endpoint
  // (what `gipity file cat` uses); it returns text content, reliable for the
  // config/code files that actually hit a restore. Binary falls through to tar.
  try {
    const res = await get<{ data: { content: string; mime?: string } }>(
      `/projects/${projectGuid}/files/read?path=${encodeURIComponent(path)}`,
    );
    const content = res?.data?.content;
    if (typeof content === 'string' && isTextMime(res?.data?.mime, path)) {
      return Buffer.from(content, 'utf-8');
    }
  } catch {
    /* fall through to the tar path */
  }

  try {
    const stream = await downloadStream(
      `/projects/${projectGuid}/files/tree?content=tar&path=${encodeURIComponent(path)}`,
    );
    // Same idle-guarded extraction as the bulk path; keep only the one entry we
    // asked for. The recovery path must not hang either, or a single stalled file
    // wedges the whole sync.
    const want = normalizeTreePath(path);
    const files = await extractTarToMap(stream, DOWNLOAD_IDLE_MS, undefined, (p) => p === want);
    return files.get(want) ?? null;
  } catch {
    return null;
  }
}

// Treat a file as text (safe to round-trip through `/files/read`'s string body)
// from its mime or, failing that, a code/config extension. Binary needs the
// byte-exact tar path.
function isTextMime(mime: string | undefined, path: string): boolean {
  if (mime && (mime.startsWith('text/') || /(json|javascript|xml|yaml|x-sh|sql)/.test(mime))) return true;
  return /\.(js|mjs|cjs|ts|tsx|jsx|json|yaml|yml|sql|md|txt|html|css|svg|csv|env|sh|toml|ini)$/i.test(path);
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
    // deleted × unchanged → delete remote. Use the remote's CURRENT version for
    // the optimistic-delete check, not the baseline's: the content can be equal
    // (rSide 'unchanged' is sha-based) while the server version moved ahead - the
    // baseline version would then fail the CAS and the delete would loop. The
    // remote read we already have carries the live version.
    if (lSide === 'deleted' && rSide === 'unchanged') {
      actions.push({ path, kind: 'delete-remote', remoteSize: R!.size, expectedServerVersion: R!.serverVersion });
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
  if (opts.force || opts.prune) return true;
  const denom = Math.max(knownFiles, 1);
  const fraction = totalDeletes / denom;
  if (totalDeletes < BULK_DELETE_COUNT || fraction < BULK_DELETE_FRACTION) return true;

  if (!opts.interactive || getAutoConfirm()) {
    // Non-interactive (deploy/test/sandbox auto-mirror): there's no human to
    // confirm, so defer the bulk deletes SILENTLY and carry them forward. This
    // is the safe default - uploads/downloads still apply, nothing is deleted -
    // and it avoids spamming a "Refusing to delete N files" error on every
    // command when a project legitimately has server-only files (e.g. runtime
    // uploads, or sandbox outputs not kept locally). The deferred count rides
    // out in SyncResult.deferredDeletes; `gipity sync --prune` applies them.
    return false;
  }
  const answer = await prompt(
    `\nPlan deletes ${totalDeletes} files (${Math.round(fraction * 100)}% of the tree). Type "delete" to confirm: `,
  );
  return answer.trim().toLowerCase() === 'delete';
}

/** Name of the optional per-project ignore file (gitignore-style: one pattern
 *  per line, blank lines and `#` comments skipped). Patterns use the same
 *  matcher as the config `ignore` list (see shouldIgnore) and let research
 *  artifacts, scratch data, or vendored references live inside the project
 *  directory without being synced (and therefore without being deployed). */
export const GIPITY_IGNORE_FILE = '.gipityignore';

export function readGipityIgnore(root: string): string[] {
  const path = join(root, GIPITY_IGNORE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.replace(/^\.\//, '').replace(/^\//, ''));
}

/** The ignore list a sync/push actually runs with: the project config's
 *  `ignore` (falling back to DEFAULT_SYNC_IGNORE when empty, so an empty list
 *  never means "sync everything - node_modules, .git and all"), plus any
 *  `.gipityignore` patterns. The ignore file itself never syncs. */
export function effectiveIgnore(root: string, configIgnore: string[] | undefined): string[] {
  const base = configIgnore && configIgnore.length ? configIgnore : DEFAULT_SYNC_IGNORE;
  return [...base, GIPITY_IGNORE_FILE, ...readGipityIgnore(root)];
}

export async function sync(opts: SyncOptions = {}): Promise<SyncResult> {
  const config = requireConfig();
  const root = projectDir();
  const interactive = opts.interactive ?? process.stdout.isTTY ?? false;

  const ignore = effectiveIgnore(root, config.ignore);

  const releaseLock = await acquireLock(opts.progress);
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
  // Ignored paths are invisible on BOTH sides: filtering only the local walk
  // would classify a remote copy as "added" (pull it), then next pass as a
  // local deletion (delete it remotely) - a churn loop. Filtering remote too
  // means a path that synced before it was ignored just stays put remotely
  // (delete it explicitly if it shouldn't be deployed).
  for (const path of [...remote.keys()]) {
    if (shouldIgnore(path, ignore)) remote.delete(path);
  }

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
      deferredDeletes: 0,
    };
  }

  // Uncertain-merge guard (armed via confirmMerge): syncing INTO a populated
  // directory we've never synced for this project (empty baseline + local files
  // that would upload or collide). Local-only files get pushed UP into the
  // project and same-path differences fork into conflict copies - a two-way
  // merge that may be unintended. Nothing here can delete.
  //
  // Three ways to resolve it, so both outcomes are scriptable:
  //   --yes / autoConfirm → proceed (merge confirmed)
  //   interactive TTY      → prompt the user
  //   non-interactive      → fail safe: ABORT rather than merge blindly
  if (
    opts.confirmMerge &&
    remote.size > 0 &&                              // project already has files - a real merge target
    Object.keys(baseline.files).length === 0 &&    // we've never synced this folder for it
    (planned.uploads > 0 || planned.conflicts > 0) // and local content would push up or collide
  ) {
    const f = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
    const shape: string[] = [`    Server: ${f(remote.size)}   ·   Local: ${f(local.size)}`];
    if (planned.downloads > 0) shape.push(`    ↓ download ${f(planned.downloads)} from the project into this folder`);
    if (planned.uploads > 0)   shape.push(`    ↑ upload ${f(planned.uploads)} from this folder INTO the project (they become part of it)`);
    if (planned.conflicts > 0) shape.push(`    ! ${f(planned.conflicts)} differ on both sides — both kept (your copy is renamed)`);

    const abort = (): SyncResult => ({
      plan: planned, applied: 0, skipped: planned.actions.length, errors: [],
      summary: [
        `This folder has files that haven't been synced with this project yet — merge not confirmed.`,
        ...shape,
        `Re-run with --yes to merge, or sync into an empty folder.`,
      ].join('\n'),
      deferredDeletes: 0, aborted: true,
    });

    if (getAutoConfirm()) {
      // --yes: proceed with the merge; the caller reports the applied counts.
    } else if (interactive) {
      const answer = await prompt([
        '',
        `  This folder has files that haven't been synced with this project yet.`,
        `  Syncing here MERGES the two — nothing is deleted:`,
        '',
        ...shape,
        '',
        `  Continue? [y/N]: `,
      ].join('\n'));
      if (!/^(y|yes|continue)$/i.test(answer.trim())) return abort();
    } else {
      // Non-interactive and not confirmed: don't silently merge a folder we
      // weren't told to. `--yes` opts in.
      return abort();
    }
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
  // Set when the download phase could not retrieve every byte the plan needs.
  // A delete is only safe against a complete, authoritative view, so an
  // incomplete download disarms the deletes pass below - this is what breaks
  // the "truncated pull → files missing locally → next sync deletes them"
  // amplification loop.
  let downloadIncomplete = false;
  const wantedDownloads = plannedToApply.filter(a => a.kind === 'download' || a.kind === 'conflict');
  if (wantedDownloads.length) {
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
      for (const a of wantedDownloads) {
        const buf = all.get(a.path);
        if (buf) downloadedBytes.set(a.path, buf);
      }
    } catch (err) {
      // The bulk tar can truncate mid-stream on a large project (transport or
      // proxy timeout) and either reject here or "finish" with a partial set.
      // Either way we fall through to the single-file recovery below rather than
      // proceeding on a half-empty tree - a partial download must never be
      // mistaken for a complete one.
      errors.push(`Bulk download incomplete (${(err as Error).message}); recovering files individually…`);
    } finally {
      // Settle the bar even if the extracted-byte tally fell short of the
      // estimate (the live line stays open until something hits 100% or finish()).
      p?.finish();
    }

    // Recover whatever the bulk tar dropped over the reliable single-file
    // endpoint. This is what lets a project whose tar keeps truncating still
    // sync to completion - and what recovers a checkout left half-downloaded by
    // an earlier truncated pull.
    const missing = wantedDownloads.filter(a => !downloadedBytes.has(a.path));
    if (missing.length) {
      p?.phase(`Recovering ${missing.length} file${missing.length === 1 ? '' : 's'} the bulk download dropped…`);
      for (const a of missing) {
        let buf: Buffer | null = null;
        for (let attempt = 0; attempt < 3 && !buf; attempt++) {
          buf = await fetchOne(config.projectGuid, a.path);
        }
        if (buf) downloadedBytes.set(a.path, buf);
      }
    }

    // Anything still missing is a hard failure: the plan needs bytes we could
    // not retrieve. Mark the download incomplete so the deletes pass is skipped;
    // the per-path "Download missing" errors below carry the detail.
    if (wantedDownloads.some(a => !downloadedBytes.has(a.path))) downloadIncomplete = true;
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
    let full: string;
    try { full = resolveInRoot(root, a.path); }
    catch (e) { errors.push((e as Error).message); continue; }
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
    let full: string;
    let renamed: string;
    try {
      full = resolveInRoot(root, a.path);
      renamed = resolveInRoot(root, a.renamedLocalTo!);
    } catch (e) { errors.push((e as Error).message); continue; }
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

  // Uploads: batched. Each chunk of UPLOAD_INIT_BATCH_SIZE files costs one
  // upload-init-batch call (the server answers per file: already-have-it /
  // conflict / presigned URL), then the S3 PUTs run UPLOAD_CONCURRENCY wide,
  // then one upload-complete-batch call registers everything that landed.
  // A single byte bar tracks the whole run (workers share the counter; JS is
  // single-threaded so the += is race-free). Files the server already has -
  // identical content at the same path, or dedup-linked from another path -
  // transfer nothing but still count their bytes, so the bar reaches 100%.
  const uploadLabel = `Uploading ${uploadQueue.length} file${uploadQueue.length === 1 ? '' : 's'}`;
  const totalUploadBytes = uploadQueue.reduce((sum, a) => sum + (a.localSize ?? 0), 0);
  let sentBytes = 0;
  if (uploadQueue.length) p?.transfer(uploadLabel, 0, totalUploadBytes);
  const onBytes = p
    ? (delta: number) => { sentBytes += delta; p.transfer(uploadLabel, sentBytes, totalUploadBytes); }
    : undefined;

  // Conflict downgrade shared by init-time and complete-time CAS rejections:
  // remote moved under us, so remote wins the canonical path - rename local,
  // restore the server copy, re-upload the rename as a brand-new path.
  const downgradeToConflict = async (
    a: Action, full: string, currentServerVersion: number | null,
  ): Promise<void> => {
    const currentBytes = await fetchOne(config.projectGuid, a.path);
    const renamedRel = conflictedCopyName(a.path);
    let renamedFull: string;
    try { renamedFull = resolveInRoot(root, renamedRel); }
    catch (e) { errors.push((e as Error).message); return; }
    try {
      renameSync(full, renamedFull);
    } catch (e) {
      errors.push(`Rename failed for ${a.path}: ${(e as Error).message}`);
      return;
    }
    if (currentBytes) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, currentBytes);
      const stat = statSync(full);
      baseline.files[a.path] = {
        size: stat.size, mtime: stat.mtime.toISOString(),
        sha256: '',  // will re-hash on next sync
        serverVersion: currentServerVersion ?? 0,
      };
    }
    try {
      const result = await uploadOneFile(
        config.projectGuid, renamedFull, renamedRel,
        { expectedServerVersion: null },
      );
      const stat = statSync(renamedFull);
      const { sha256 } = await hashFile(renamedFull);
      baseline.files[renamedRel] = {
        size: stat.size, mtime: stat.mtime.toISOString(),
        sha256, serverVersion: result.serverVersion,
      };
    } catch (e) {
      errors.push(`Conflict-copy upload failed for ${renamedRel}: ${(e as Error).message}`);
    }
    applied++;
  };

  interface PreparedUpload { a: Action; full: string; size: number; mtime: string; sha256: string }
  for (let chunkStart = 0; chunkStart < uploadQueue.length; chunkStart += UPLOAD_INIT_BATCH_SIZE) {
    const chunk = uploadQueue.slice(chunkStart, chunkStart + UPLOAD_INIT_BATCH_SIZE);

    // Stat + hash once per file; the same numbers feed init, the baseline,
    // and the bar. Files that vanished or escaped the root drop out here.
    const prepared: PreparedUpload[] = [];
    for (const a of chunk) {
      if (a.path.length > UPLOAD_MAX_PATH_CHARS) {
        errors.push(`Upload failed for ${a.path}: path exceeds ${UPLOAD_MAX_PATH_CHARS} characters`);
        onBytes?.(a.localSize ?? 0);
        continue;
      }
      let full: string;
      try { full = resolveInRoot(root, a.path); }
      catch (e) { errors.push((e as Error).message); onBytes?.(a.localSize ?? 0); continue; }
      try {
        const stat = statSync(full);
        if (stat.size > UPLOAD_MAX_BYTES) {
          errors.push(`Upload failed for ${a.path}: file exceeds the 30 GB upload limit`);
          onBytes?.(a.localSize ?? 0);
          continue;
        }
        const sha256 = local.get(a.path)?.sha256 ?? (await hashFile(full)).sha256;
        prepared.push({ a, full, size: stat.size, mtime: stat.mtime.toISOString(), sha256 });
      } catch (e) {
        errors.push(`Upload failed for ${a.path}: ${(e as Error).message}`);
        onBytes?.(a.localSize ?? 0);
      }
    }
    if (!prepared.length) continue;

    let initResults: BatchInitResult[];
    try {
      initResults = await uploadInitBatch(config.projectGuid, prepared.map(pr => ({
        path: pr.a.path, size: pr.size, sha256: pr.sha256, mime: guessMime(pr.a.path),
        ...(pr.a.expectedServerVersion !== undefined
          ? { expected_server_version: pr.a.expectedServerVersion } : {}),
      })));
    } catch (e) {
      errors.push(`Upload batch failed: ${(e as Error).message}`);
      for (const pr of prepared) onBytes?.(pr.size);
      continue;
    }

    const byPath = new Map(prepared.map(pr => [pr.a.path, pr]));
    const conflicted: Array<{ pr: PreparedUpload; current: number | null }> = [];
    const ready: Array<{ pr: PreparedUpload; init: Extract<BatchInitResult, { status: 'ready' }> }> = [];
    for (const r of initResults) {
      const pr = byPath.get(r.path);
      if (!pr) continue;
      switch (r.status) {
        case 'already_current':
          baseline.files[pr.a.path] = {
            size: pr.size, mtime: pr.mtime, sha256: pr.sha256, serverVersion: r.server_version,
          };
          onBytes?.(pr.size);
          applied++;
          break;
        case 'conflict':
          // No PUT happens for a file rejected at init - account its bytes now
          // so the bar still reaches 100% (the conflict copy is extra work
          // outside the byte budget). Complete-time conflicts differ: their PUT
          // already reported the bytes, so that branch must NOT re-count.
          onBytes?.(pr.size);
          conflicted.push({ pr, current: r.current_server_version });
          break;
        case 'error':
          errors.push(`Upload failed for ${r.path}: ${r.message}`);
          onBytes?.(pr.size);
          break;
        default:
          ready.push({ pr, init: r });
      }
    }

    // S3 PUTs, UPLOAD_CONCURRENCY wide; collect upload-complete items as they land.
    const toComplete: Array<{ pr: PreparedUpload; item: BatchCompleteItem }> = [];
    let cursor = 0;
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < Math.min(UPLOAD_CONCURRENCY, ready.length); w++) {
      workers.push((async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= ready.length) return;
          const { pr, init } = ready[idx];
          try {
            const fields = await transferToS3(pr.full, pr.size, guessMime(pr.a.path), init, { onBytes });
            toComplete.push({ pr, item: {
              upload_guid: init.upload_guid, ...fields,
              ...(pr.a.expectedServerVersion !== undefined
                ? { expected_server_version: pr.a.expectedServerVersion } : {}),
            } });
          } catch (err) {
            errors.push(`Upload failed for ${pr.a.path}: ${(err as Error).message}`);
          }
        }
      })());
    }
    await Promise.all(workers);

    if (toComplete.length) {
      const byGuid = new Map(toComplete.map(c => [c.item.upload_guid, c.pr]));
      try {
        for (const r of await uploadCompleteBatch(config.projectGuid, toComplete.map(c => c.item))) {
          const pr = byGuid.get(r.upload_guid);
          if (!pr) continue;
          switch (r.status) {
            case 'completed':
              baseline.files[pr.a.path] = {
                size: pr.size, mtime: pr.mtime, sha256: pr.sha256, serverVersion: r.server_version,
              };
              applied++;
              break;
            case 'conflict':
              conflicted.push({ pr, current: r.current_server_version });
              break;
            default:
              errors.push(`Upload failed for ${pr.a.path}: ${r.message}`);
          }
        }
      } catch (e) {
        errors.push(`Upload batch failed: ${(e as Error).message}`);
      }
    }

    // Conflict downgrades are rare - handle them one at a time.
    for (const { pr, current } of conflicted) {
      await downgradeToConflict(pr.a, pr.full, current);
    }
  }

  // ── Deletes pass ──
  // A delete is only safe against a complete, authoritative view. If the
  // download phase couldn't retrieve everything it planned, the local tree is
  // not a trustworthy deletion signal - this is exactly how a truncated pull
  // turns "files we failed to fetch" into "delete those files." Skip ALL deletes
  // this run and let a clean sync replan them once the pull succeeds.
  let deletesSkippedIncomplete = 0;
  for (const a of plannedToApply) {
    if (downloadIncomplete && (a.kind === 'delete-local' || a.kind === 'delete-remote')) {
      deletesSkippedIncomplete++;
      continue;
    }
    if (a.kind === 'delete-local') {
      try {
        unlinkSync(resolveInRoot(root, a.path));
      } catch { /* already gone or outside root */ }
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
          // Delete-vs-newer: the live file advanced past the version the plan
          // saw (stale tree read or a concurrent write). Resolve it with the
          // same rule the planner applies to deleted × modified — remote wins:
          // restore the server copy locally and advance the baseline so the
          // next round starts from agreement (delete again + re-sync to
          // confirm the delete). Leaving the baseline stale here trapped the
          // delete in an unresolvable loop, minting a fresh conflict copy
          // every round.
          try {
            const buf = await fetchOne(config.projectGuid, a.path);
            if (!buf) throw new Error('remote bytes unavailable');
            const full = resolveInRoot(root, a.path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, buf);
            const stat = statSync(full);
            const { sha256 } = await hashFile(full);
            const current = typeof err.data?.current_server_version === 'number'
              ? err.data.current_server_version : null;
            baseline.files[a.path] = {
              size: stat.size, mtime: stat.mtime.toISOString(), sha256,
              serverVersion: current ?? a.expectedServerVersion ?? 0,
            };
            errors.push(`Could not delete ${a.path}: server has a newer version - restored the server copy locally (delete it again and re-sync to confirm)`);
          } catch {
            // Restore failed (e.g. the bytes truly couldn't be fetched). DROP the
            // baseline entry rather than leave a stale one: a stale entry re-plans
            // the same impossible delete every run (the original loop). With no
            // baseline, the next sync re-evaluates this path from scratch — as a
            // remote 'added' it downloads cleanly, no loop.
            delete baseline.files[a.path];
            errors.push(`Could not delete ${a.path}: server has a newer version - reset its sync state; re-run \`gipity sync\` to pull the server copy.`);
          }
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

  if (deletesSkippedIncomplete > 0) {
    errors.push(
      `Skipped ${deletesSkippedIncomplete} deletion${deletesSkippedIncomplete === 1 ? '' : 's'} because the download was incomplete - ` +
      `nothing was deleted. Re-run \`gipity sync\` once the pull finishes to apply any real deletions.`,
    );
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
    deferredDeletes: skippedByGuard,
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
  if (shouldIgnore(rel, effectiveIgnore(root, config.ignore))) return;

  // Serialize against `gipity sync` and other concurrent pushes by holding the
  // same per-project lock `sync()` uses. Both paths read-modify-write the shared
  // baseline; without a common lock, a burst of PostToolUse pushes (each a
  // detached `gipity push`) racing the UserPromptSubmit/post-dispatch reconciles
  // drops baseline updates, and the 3-way merge then misreads our own just-pushed
  // edits as `modified×modified` conflicts (or pulls stale bytes over a live
  // edit). Read the baseline AFTER acquiring the lock so earlier pushes' writes
  // are visible. (WS-00172)
  const releaseLock = await acquireLock();
  try {
    const baseline = readBaseline(config.projectGuid);
    const baseEntry = baseline.files[rel];
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
  } finally {
    releaseLock();
  }
}

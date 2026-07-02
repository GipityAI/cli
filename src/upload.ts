import { createReadStream } from 'fs';
import { Transform } from 'stream';
import { extname } from 'path';
import { createHash } from 'crypto';
import { post, putToPresignedUrl, ApiError } from './api.js';

// Concurrency: parallel files in a batch + parallel parts within one multipart file.
// File-level parallelism is high because most files are small: the cost of a
// small file is round-trip latency, not bandwidth, so wider = proportionally
// faster. S3 PUTs go direct to S3; the API only sees batched init/complete.
export const UPLOAD_CONCURRENCY = 16;
const MULTIPART_PART_CONCURRENCY = 4;

/** Files per upload-init-batch / upload-complete-batch call. Must not exceed
 *  the server's UPLOAD_BATCH_MAX_ITEMS (200). */
export const UPLOAD_INIT_BATCH_SIZE = 100;

// Server-side per-file caps (PRESIGNED_UPLOAD_MAX_BYTES and the upload-init
// path length in platform). The batch routes Zod-validate the whole array, so
// one over-limit file would 400 its entire chunk - pre-check per file instead
// and fail just that file, matching the old single-endpoint behavior.
export const UPLOAD_MAX_BYTES = 30 * 1024 * 1024 * 1024;
export const UPLOAD_MAX_PATH_CHARS = 1000;

// Keep in sync with server's guessMime in platform/server/src/services/vfs/path-helpers.ts
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.md': 'text/markdown', '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.exe': 'application/x-executable',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMime(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Stream-hash a file in one pass. Returns SHA-256 hex + size. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const stream = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => {
      const buf = chunk as Buffer;
      hash.update(buf);
      size += buf.length;
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return { sha256: hash.digest('hex'), size };
}

/** Read a single fixed-size byte range of a file as a Buffer (for multipart parts). */
function readRange(path: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end });
    stream.on('data', (c) => { chunks.push(c as Buffer); });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Bounded retry for transient PUT failures (network blips, S3 5xx). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry 4xx (auth, validation, gone) - only network/5xx.
      if (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 408) {
        throw err;
      }
      if (i === attempts - 1) break;
      const delay = 500 * Math.pow(2, i);
      await new Promise(r => setTimeout(r, delay));
      console.error(`[upload] ${label} attempt ${i + 1} failed, retrying in ${delay}ms: ${(err as Error).message}`);
    }
  }
  throw lastErr;
}

/** An initialized upload the server expects bytes for: a presigned single PUT
 *  or a multipart part fan-out (possibly resumed). */
export type ReadyInit =
  | {
      upload_guid: string;
      method: 'PUT';
      url: string;
      headers?: Record<string, string>;
      expires_in: number;
      resumed?: boolean;
    }
  | {
      upload_guid: string;
      method: 'multipart';
      upload_id: string;
      part_size: number;
      parts: Array<{ partNumber: number; url: string }>;
      completed_parts?: Array<{ part_number: number; etag: string }>;
      expires_in: number;
      resumed?: boolean;
    };

type InitData =
  | { already_current: true; guid: string; size: number; server_version: number }
  | (ReadyInit & { already_current?: false });
interface InitResponse { data: InitData }

export interface UploadOpts {
  mime?: string;
  /** Override per-file part-upload concurrency (multipart only). */
  partConcurrency?: number;
  /** CAS token: pass the baseline `serverVersion` for an expected-existing file,
   *  `null` when the file is expected to be new, or omit (undefined) to skip the
   *  CAS check entirely (e.g. tool-driven writes, scaffolding). On mismatch the
   *  server returns 409 and this function throws {@link UploadConflictError}. */
  expectedServerVersion?: number | null;
  /** Called as bytes land on the wire, with the byte delta for each chunk
   *  (one multipart part, or the whole body for a single PUT). Lets callers
   *  drive a transfer progress bar. Already-uploaded parts on resume are
   *  reported up front so the total still reaches 100%. */
  onBytes?: (deltaBytes: number) => void;
}

export interface UploadResult {
  /** 'skipped' = server says already current; 'resumed' = server returned remaining parts; 'uploaded' = fresh upload. */
  status: 'skipped' | 'resumed' | 'uploaded';
  size: number;
  /** node short_guid */
  guid: string;
  /** vfs version number (1+); undefined when skipped. */
  version?: number;
  /** CAS counter on the live node after this operation. Present on skip (=current) and upload (=bumped). */
  serverVersion: number;
}

/** Thrown when the server rejects an upload due to CAS mismatch. */
export class UploadConflictError extends Error {
  constructor(public readonly currentServerVersion: number | null, public readonly path: string) {
    super(`Version mismatch for ${path}: current serverVersion is ${currentServerVersion}`);
    this.name = 'UploadConflictError';
  }
}

/**
 * Upload one local file to a project's virtual path via the presigned-S3 flow.
 * Handles single-part PUT and multipart fan-out, server-driven resume, and
 * skip-if-identical (a byte-identical file at the same path is a no-op).
 */
export async function uploadOneFile(
  projectGuid: string, localPath: string, virtualPath: string, opts: UploadOpts = {},
): Promise<UploadResult> {
  const { sha256, size } = await hashFile(localPath);
  const mime = opts.mime ?? guessMime(virtualPath);

  const initBody: Record<string, unknown> = { path: virtualPath, size, sha256, mime };
  if (opts.expectedServerVersion !== undefined) {
    initBody.expected_server_version = opts.expectedServerVersion;
  }

  let init: InitResponse;
  try {
    init = await post<InitResponse>(
      `/projects/${projectGuid}/files/upload-init`,
      initBody,
    );
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      const current = typeof err.data?.current_server_version === 'number'
        ? err.data.current_server_version : null;
      throw new UploadConflictError(current, virtualPath);
    }
    throw err;
  }
  const data = init.data;

  // Skip-if-identical fast path. Count the bytes as "done" - the server has
  // them - so a caller's progress bar still reaches 100%.
  if ('already_current' in data && data.already_current) {
    opts.onBytes?.(size);
    return { status: 'skipped', size, guid: data.guid, serverVersion: data.server_version };
  }

  const fields = await transferToS3(localPath, size, mime, data, opts);

  const completeBody: Record<string, unknown> = { upload_guid: data.upload_guid, ...fields };
  if (opts.expectedServerVersion !== undefined) {
    completeBody.expected_server_version = opts.expectedServerVersion;
  }
  let comp: { data: { size: number; guid: string; version: number; server_version: number } };
  try {
    comp = await post(`/projects/${projectGuid}/files/upload-complete`, completeBody);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      const current = typeof err.data?.current_server_version === 'number'
        ? err.data.current_server_version : null;
      throw new UploadConflictError(current, virtualPath);
    }
    throw err;
  }
  return {
    status: data.resumed ? 'resumed' : 'uploaded',
    size: comp.data.size,
    guid: comp.data.guid,
    version: comp.data.version,
    serverVersion: comp.data.server_version,
  };
}

/**
 * Move one file's bytes to S3 for an initialized upload: a single presigned
 * PUT, or the multipart part fan-out (including server-driven resume).
 * Returns the field upload-complete needs - `etag` for single-part, `parts`
 * for multipart. Reports progress through opts.onBytes.
 */
export async function transferToS3(
  localPath: string, size: number, mime: string, data: ReadyInit,
  opts: Pick<UploadOpts, 'partConcurrency' | 'onBytes'> = {},
): Promise<{ etag: string } | { parts: Array<{ part_number: number; etag: string }> }> {
  // Single-part (covers fresh + resumed PUT - single PUT is idempotent on the staging key).
  if (data.method === 'PUT') {
    // Report bytes as they flow to S3 so the progress bar moves during the
    // transfer instead of sitting at 0% until the whole file lands (a large
    // file - e.g. a 674 MB video - otherwise looks hung for minutes). A
    // pass-through Transform counts each chunk as fetch pulls it; we don't
    // attach a 'data' listener, which would drain the stream before fetch
    // reads it.
    let reported = 0;
    const etag = await withRetry('PUT', async () => {
      // A retried attempt re-streams from the top, so back out whatever the
      // failed attempt already counted to keep the shared total accurate.
      if (reported) { opts.onBytes?.(-reported); reported = 0; }
      const stream = createReadStream(localPath);
      let body: NodeJS.ReadableStream = stream;
      if (opts.onBytes) {
        const counter = new Transform({
          transform(chunk, _enc, cb) { reported += chunk.length; opts.onBytes!(chunk.length); cb(null, chunk); },
        });
        stream.on('error', err => counter.destroy(err));
        body = stream.pipe(counter);
      }
      return putToPresignedUrl(
        data.url, body, size,
        data.headers?.['Content-Type'] ?? mime,
      );
    });
    // True up to exactly `size`: a dedup/no-op PUT streams nothing, and chunk
    // sums can fall a hair short of the stat size on the final read.
    if (reported !== size) opts.onBytes?.(size - reported);
    return { etag };
  }

  // Multipart - start with any parts that already landed (resume case).
  const partSize = data.part_size;
  const partUrls = data.parts;            // missing parts to upload now
  const alreadyDone = data.completed_parts ?? [];
  const totalParts = Math.ceil(size / partSize);

  // Build the final parts array indexed by partNumber.
  const completed: Array<{ part_number: number; etag: string }> = [];
  for (const p of alreadyDone) completed.push(p);

  // On resume, count the parts the server already has so the progress total
  // still reaches 100% (capped at size for the short final part).
  if (alreadyDone.length) opts.onBytes?.(Math.min(alreadyDone.length * partSize, size));

  const partConcurrency = opts.partConcurrency ?? MULTIPART_PART_CONCURRENCY;
  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(partConcurrency, partUrls.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= partUrls.length) return;
        const part = partUrls[idx];
        const start = (part.partNumber - 1) * partSize;
        const end = Math.min(start + partSize - 1, size - 1);
        const body = await readRange(localPath, start, end);
        const etag = await withRetry(`part ${part.partNumber}`, () =>
          putToPresignedUrl(part.url, body, body.length),
        );
        opts.onBytes?.(body.length);
        completed.push({ part_number: part.partNumber, etag });
      }
    })());
  }
  await Promise.all(workers);

  // Sanity: server expects all totalParts present.
  if (completed.length !== totalParts) {
    throw new Error(`Multipart upload incomplete: expected ${totalParts} parts, have ${completed.length}`);
  }
  // Sort by part_number so server CompleteMultipartUpload sees ascending order.
  completed.sort((a, b) => a.part_number - b.part_number);

  return { parts: completed };
}

// ── Batched init/complete (sync engine) ─────────────────────────
// One API round trip per UPLOAD_INIT_BATCH_SIZE files in each direction
// instead of two per file. The S3 PUTs in between still go per file, direct
// to S3, with UPLOAD_CONCURRENCY of them in flight.

export interface BatchInitFile {
  path: string;
  size: number;
  sha256: string;
  mime: string;
  expected_server_version?: number | null;
}

export type BatchInitResult =
  | { path: string; status: 'already_current'; guid: string; size: number; server_version: number }
  | ({ path: string; status: 'ready' } & ReadyInit)
  | { path: string; status: 'conflict'; current_server_version: number | null }
  | { path: string; status: 'error'; message: string };

export async function uploadInitBatch(
  projectGuid: string, files: BatchInitFile[],
): Promise<BatchInitResult[]> {
  const res = await post<{ data: { results: BatchInitResult[] } }>(
    `/projects/${projectGuid}/files/upload-init-batch`, { files },
  );
  return res.data.results;
}

export interface BatchCompleteItem {
  upload_guid: string;
  etag?: string;
  parts?: Array<{ part_number: number; etag: string }>;
  expected_server_version?: number | null;
}

export type BatchCompleteResult =
  | { upload_guid: string; status: 'completed'; size: number; guid: string; version: number; server_version: number }
  | { upload_guid: string; status: 'conflict'; current_server_version: number | null }
  | { upload_guid: string; status: 'error'; code?: string; message: string };

export async function uploadCompleteBatch(
  projectGuid: string, items: BatchCompleteItem[],
): Promise<BatchCompleteResult[]> {
  const res = await post<{ data: { results: BatchCompleteResult[] } }>(
    `/projects/${projectGuid}/files/upload-complete-batch`, { items },
  );
  return res.data.results;
}

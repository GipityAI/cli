import { createReadStream } from 'fs';
import { extname } from 'path';
import { createHash } from 'crypto';
import { post, putToPresignedUrl, ApiError } from './api.js';

// Concurrency: parallel files in a batch + parallel parts within one multipart file.
export const UPLOAD_CONCURRENCY = 4;
const MULTIPART_PART_CONCURRENCY = 4;

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

type InitData =
  | { already_current: true; guid: string; size: number; server_version: number }
  | {
      already_current?: false;
      upload_guid: string;
      method: 'PUT';
      url: string;
      headers?: Record<string, string>;
      expires_in: number;
      resumed?: boolean;
    }
  | {
      already_current?: false;
      upload_guid: string;
      method: 'multipart';
      upload_id: string;
      part_size: number;
      parts: Array<{ partNumber: number; url: string }>;
      completed_parts?: Array<{ part_number: number; etag: string }>;
      expires_in: number;
      resumed?: boolean;
    };
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
 * skip-if-identical (unless overwrite=true forces a new version).
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

  // Skip-if-identical fast path.
  if ('already_current' in data && data.already_current) {
    return { status: 'skipped', size, guid: data.guid, serverVersion: data.server_version };
  }

  const completeBody: Record<string, unknown> = { upload_guid: data.upload_guid };
  if (opts.expectedServerVersion !== undefined) {
    completeBody.expected_server_version = opts.expectedServerVersion;
  }

  // Single-part (covers fresh + resumed PUT - single PUT is idempotent on the staging key).
  if (data.method === 'PUT') {
    const etag = await withRetry('PUT', async () => {
      const stream = createReadStream(localPath);
      return putToPresignedUrl(
        data.url, stream, size,
        data.headers?.['Content-Type'] ?? mime,
      );
    });
    opts.onBytes?.(size);
    completeBody.etag = etag;
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

  completeBody.parts = completed;
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

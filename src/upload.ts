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
      // Don't retry 4xx (auth, validation, gone) — only network/5xx.
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
  | { already_current: true; guid: string; size: number }
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
  /** Force a new version even if the server-side SHA-256 matches the current version. */
  overwrite?: boolean;
  /** Override per-file part-upload concurrency (multipart only). */
  partConcurrency?: number;
}

export interface UploadResult {
  /** 'skipped' = server says already current; 'resumed' = server returned remaining parts; 'uploaded' = fresh upload. */
  status: 'skipped' | 'resumed' | 'uploaded';
  size: number;
  /** node short_guid */
  guid: string;
  /** vfs version number (1+); undefined when skipped. */
  version?: number;
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
  if (opts.overwrite) initBody.overwrite = true;

  const init = await post<InitResponse>(
    `/projects/${projectGuid}/files/upload-init`,
    initBody,
  );
  const data = init.data;

  // Skip-if-identical fast path.
  if ('already_current' in data && data.already_current) {
    return { status: 'skipped', size, guid: data.guid };
  }

  // Single-part (covers fresh + resumed PUT — single PUT is idempotent on the staging key).
  if (data.method === 'PUT') {
    const etag = await withRetry('PUT', async () => {
      const stream = createReadStream(localPath);
      return putToPresignedUrl(
        data.url, stream, size,
        data.headers?.['Content-Type'] ?? mime,
      );
    });
    const comp = await post<{ data: { size: number; guid: string; version: number } }>(
      `/projects/${projectGuid}/files/upload-complete`,
      { upload_guid: data.upload_guid, etag },
    );
    return {
      status: data.resumed ? 'resumed' : 'uploaded',
      size: comp.data.size,
      guid: comp.data.guid,
      version: comp.data.version,
    };
  }

  // Multipart — start with any parts that already landed (resume case).
  const partSize = data.part_size;
  const partUrls = data.parts;            // missing parts to upload now
  const alreadyDone = data.completed_parts ?? [];
  const totalParts = Math.ceil(size / partSize);

  // Build the final parts array indexed by partNumber.
  const completed: Array<{ part_number: number; etag: string }> = [];
  for (const p of alreadyDone) completed.push(p);

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

  const comp = await post<{ data: { size: number; guid: string; version: number } }>(
    `/projects/${projectGuid}/files/upload-complete`,
    { upload_guid: data.upload_guid, parts: completed },
  );
  return {
    status: data.resumed ? 'resumed' : 'uploaded',
    size: comp.data.size,
    guid: comp.data.guid,
    version: comp.data.version,
  };
}

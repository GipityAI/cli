/**
 * Transcript image rewrite — the relay's "no inline base64" chokepoint.
 *
 * Claude Code's `Read` of an image file (screenshots, generated art, …)
 * returns the bytes as a `{type:'image', source:{type:'base64', data}}`
 * block inside the tool_result. Shipping that through ingest bloats the
 * transcript DB and, worse, blows the server's 200 KB per-entry cap so
 * real screenshots silently never reach the web client at all.
 *
 * `ImageBlockRewriter` sits in front of the ingest POST: it uploads each
 * base64 image block's bytes to `POST /remote-sessions/:convGuid/media`
 * (raw binary body) and swaps the block for a small `image_ref` pointing
 * at the stored VFS file. The server dedups by content hash — a `Read` of
 * an already-synced screenshot references the existing node.
 *
 * Failure handling: an upload that fails leaves small images inline
 * (status-quo rendering still works) but replaces oversize ones with a
 * text stub so one bad image can't poison the whole ingest batch. The
 * IngestQueue retries a failed batch through this rewriter again, and the
 * server's content-addressed storage makes replayed uploads idempotent.
 */
import path from 'path';
import { deviceFetchBinary } from './device-http.js';

/** Structural view of an ingest entry — the daemon (relay/stream-json.ts)
 *  and the hook runner (capture/sources/claude-code.ts) declare separate
 *  IngestEntry unions, so the rewriter types against the shape it needs. */
interface EntryShape {
  kind: string;
  tool_use_id?: string;
  tool_input?: unknown;
  content?: unknown;
}

/** Below this the upload round-trip outweighs the base64: tiny images
 *  (icons, favicons) stay inline. */
const MIN_UPLOAD_BYTES = 4 * 1024;
/** Server-side cap (TRANSCRIPT_MEDIA_MAX_BYTES). Larger images can't be
 *  stored; they get stubbed rather than shipped. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Base64 payloads above this would break the server's 200 KB tool_result
 *  cap if left inline — when the upload fails, stub instead of poisoning
 *  the batch. Leaves headroom for the rest of the tool_result JSON. */
const INLINE_SAFE_B64_CHARS = 120_000;
/** How many tool_use → file_path pairs to remember for captioning/dedup. */
const PATH_MAP_CAP = 500;

interface StoredRef {
  guid: string;
  url: string;
  thumb_url: string | null;
  path: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

/** Upload one image's bytes; returns the stored ref. Injectable for tests
 *  (same pattern as IngestQueue's poster). */
export type MediaUploader = (
  convGuid: string,
  buf: Buffer,
  opts: { filename: string; mediaType: string; suggestedPath?: string },
) => Promise<StoredRef>;

/** Default uploader: raw-binary POST to the transcript-media endpoint. */
export const uploadViaDevice: MediaUploader = async (convGuid, buf, opts) => {
  const qs = new URLSearchParams({ filename: opts.filename, media_type: opts.mediaType });
  if (opts.suggestedPath) qs.set('suggested_path', opts.suggestedPath);
  const res = await deviceFetchBinary(
    'POST',
    `/remote-sessions/${encodeURIComponent(convGuid)}/media?${qs.toString()}`,
    buf,
    opts.mediaType,
    30_000,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  const json = await res.json() as { data: StoredRef };
  return json.data;
};

function extForMime(mime: string | undefined): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/svg+xml': return '.svg';
    default: return '.png';
  }
}

function isBase64ImageBlock(b: any): b is { type: 'image'; source: { type: 'base64'; media_type?: string; data: string } } {
  return b?.type === 'image'
    && b.source?.type === 'base64'
    && typeof b.source.data === 'string'
    && b.source.data.length > 0;
}

export class ImageBlockRewriter {
  /** tool_use_id → the file_path the tool was asked to read (for naming +
   *  server-side dedup against the synced node at that path). */
  private pathsByToolUseId = new Map<string, string>();
  /** Project root on this machine, once the dispatch resolves it — lets an
   *  absolute Read path map to its project-relative VFS path. */
  private cwd: string | null = null;

  constructor(
    private readonly convGuid: string,
    private readonly onWarn?: (msg: string, meta?: Record<string, unknown>) => void,
    private readonly upload: MediaUploader = uploadViaDevice,
  ) {}

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Rewrite every base64 image block in the batch to an image_ref. Never
   *  throws — per-image failures degrade per the policy above. */
  async rewrite<T extends EntryShape>(entries: T[]): Promise<T[]> {
    const out: T[] = [];
    for (const entry of entries) {
      if (entry.kind === 'tool_use') {
        this.recordToolPath(entry);
        out.push(entry);
        continue;
      }
      if (entry.kind !== 'tool_result' || !Array.isArray(entry.content) || typeof entry.tool_use_id !== 'string') {
        out.push(entry);
        continue;
      }
      const blocks = [];
      for (const block of entry.content) {
        blocks.push(isBase64ImageBlock(block)
          ? await this.rewriteBlock(block, entry.tool_use_id)
          : block);
      }
      out.push({ ...entry, content: blocks });
    }
    return out;
  }

  private recordToolPath(entry: EntryShape): void {
    if (typeof entry.tool_use_id !== 'string') return;
    const input = entry.tool_input as Record<string, unknown> | null | undefined;
    const p = input && typeof input === 'object'
      ? (input.file_path ?? input.path ?? input.notebook_path)
      : undefined;
    if (typeof p !== 'string' || !p) return;
    if (this.pathsByToolUseId.size >= PATH_MAP_CAP) {
      const oldest = this.pathsByToolUseId.keys().next().value;
      if (oldest !== undefined) this.pathsByToolUseId.delete(oldest);
    }
    this.pathsByToolUseId.set(entry.tool_use_id, p);
  }

  private async rewriteBlock(
    block: { type: 'image'; source: { type: 'base64'; media_type?: string; data: string } },
    toolUseId: string,
  ): Promise<unknown> {
    const b64 = block.source.data;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return block; // not decodable — leave as-is
    }
    if (buf.length < MIN_UPLOAD_BYTES) return block;

    const mediaType = block.source.media_type || 'image/png';
    const sourcePath = this.pathsByToolUseId.get(toolUseId);
    const filename = sourcePath ? path.basename(sourcePath) : `image${extForMime(mediaType)}`;
    const suggested = this.projectRelative(sourcePath);

    if (buf.length > MAX_UPLOAD_BYTES) {
      this.onWarn?.('transcript image exceeds upload cap - stubbed', { bytes: buf.length, filename });
      return this.stub(filename, buf.length, 'too large to store');
    }

    try {
      const ref = await this.upload(this.convGuid, buf, {
        filename, mediaType, ...(suggested ? { suggestedPath: suggested } : {}),
      });
      return {
        type: 'image_ref',
        url: ref.url,
        ...(ref.thumb_url ? { thumb_url: ref.thumb_url } : {}),
        media_type: mediaType,
        path: ref.path,
        ...(ref.width != null ? { width: ref.width } : {}),
        ...(ref.height != null ? { height: ref.height } : {}),
        bytes: ref.bytes,
      };
    } catch (err: any) {
      this.onWarn?.('transcript image upload failed', { filename, err: err?.message });
      // Small enough to survive the ingest cap inline → keep the original
      // (renders exactly as before this feature). Oversize → stub, because
      // shipping it would 400 the entire batch and lose sibling entries.
      if (b64.length <= INLINE_SAFE_B64_CHARS) return block;
      return this.stub(filename, buf.length, `upload failed: ${err?.message || 'unknown error'}`);
    }
  }

  private stub(filename: string, bytes: number, reason: string): unknown {
    return {
      type: 'text',
      text: `[image ${filename} (${Math.round(bytes / 1024)} KB) omitted: ${reason}]`,
    };
  }

  /** Map an absolute local path to its project-relative VFS path, when it
   *  falls inside the dispatch's project root. */
  private projectRelative(p: string | undefined): string | undefined {
    if (!p || !this.cwd) return undefined;
    const abs = path.resolve(p);
    const root = path.resolve(this.cwd);
    if (!abs.startsWith(root + path.sep)) return undefined;
    return abs.slice(root.length + 1).split(path.sep).join('/');
  }
}

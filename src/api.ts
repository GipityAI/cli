import { Readable } from 'stream';
import * as tar from 'tar-stream';
import { getAuth, refreshTokenIfNeeded, forceRefreshAccessToken } from './auth.js';
import { resolveApiBase, requireConfig, saveConfig } from './config.js';
import { clientHeaders } from './client-context.js';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    /** Structured sidecar payload from the server (e.g. current_server_version on CAS 409s). */
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Bound every network call so a wedged connection becomes a clear error instead
// of an unbounded hang (the "sync gets stuck forever" bug). JSON API calls must
// finish well within REQUEST_TIMEOUT_MS; the S3 PUT path keeps its own
// size-based timeout. Streaming downloads can't use a single total cap (a large
// but healthy tree would be cut off mid-stream), so downloadStream bounds only
// the time-to-first-byte here and an idle watchdog in sync.ts guards the body.
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_HEADER_TIMEOUT_MS = 30_000;

/** fetch() that rejects with a clean 408 ApiError if the whole exchange (headers
 *  + body) doesn't complete within timeoutMs, instead of hanging forever. For
 *  request/response JSON calls only - never wrap a long streaming body in this. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new ApiError(408, 'REQUEST_TIMEOUT', `${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }
}

/** Resolve the Bearer token value. A GIPITY_TOKEN env var (a long-lived agent
 *  API token) takes precedence over the saved session — the persistent,
 *  login-free path for headless agents and CI. Falls back to the refreshed
 *  session access token. */
async function bearerToken(): Promise<string> {
  const envToken = process.env.GIPITY_TOKEN?.trim();
  if (envToken) return envToken;
  await refreshTokenIfNeeded();
  const auth = getAuth();
  if (!auth) throw new Error('Not authenticated. Run: gipity login');
  return auth.accessToken;
}

/** True when a long-lived agent API token (GIPITY_TOKEN) is in play. Such a token
 *  is static — it can't be refreshed — so the 401 self-heal path must skip it and
 *  the "run: gipity login" hint must not be shown (that's the wrong recovery for
 *  env-token callers). Exported so `gipity status` can name the auth source. */
export function usingEnvToken(): boolean {
  return !!process.env.GIPITY_TOKEN?.trim();
}

// A transient 401 on a session token means the access token the server just saw
// is dead NOW — it lapsed at the refresh boundary, a sibling `gipity` process
// sharing this auth.json rotated the single-use refresh token out from under us,
// or clock skew put us past expiry while the 5-min refresh buffer still read
// "fresh". refreshTokenIfNeeded's fast-path skips a locally-fresh token, so we
// force a refresh and replay the call once. This self-heals the intermittent
// "Session expired" that surfaced on `page eval` (a kickoff POST plus a long GET
// poll loop crosses the refresh boundary many times). These two helpers carry
// that behavior to EVERY authenticated entry point — including the streaming and
// download paths (downloadStream → sync, postForTarEntries → page screenshot)
// that bypass request() — so one raced 401 can't hard-fail them either.

/** Decide whether to replay an authenticated call after a 401: force one token
 *  refresh and return true if the caller should retry. False for an env-token
 *  caller (static, unrefreshable), an already-retried call, a non-401, or an
 *  unrecoverable session — the caller then surfaces the error. */
async function shouldRetryAfter401(status: number, retried: boolean): Promise<boolean> {
  if (status !== 401 || retried || usingEnvToken()) return false;
  return forceRefreshAccessToken();
}

/** Append a re-login hint to a 401 message for session users. A 401 that
 *  survived the refresh-and-retry is an unrecoverable session (the refresh token
 *  is gone too); env-token callers authenticate differently, so don't misdirect
 *  them. Names the headless path too — an unattended agent has no mailbox for
 *  the emailed login code, and dead-ending there stranded whole runs (cli#137). */
function with401Hint(status: number, message: string): string {
  return status === 401 && !usingEnvToken()
    ? `${message} — run: gipity login (headless/CI: set GIPITY_TOKEN instead — gipity skill read agent-deploy)`
    : message;
}

async function getHeaders(): Promise<Record<string, string>> {
  return {
    ...clientHeaders(),
    'Authorization': `Bearer ${await bearerToken()}`,
    'Content-Type': 'application/json',
  };
}

function baseUrl(): string {
  return resolveApiBase();
}

/** Exposed so streaming consumers (SSE) can build URLs without re-implementing
 *  the override / config resolution. */
export function getBaseUrl(): string {
  return baseUrl();
}

/** Returns the access-token Authorization header value so streaming consumers
 *  can attach it to fetch/EventSource calls. */
export async function getAuthHeader(): Promise<string | undefined> {
  const headers = await getHeaders();
  return headers.Authorization;
}

async function request<T>(method: string, path: string, body?: unknown, retrying = false): Promise<T> {
  const headers = await getHeaders();
  const url = `${baseUrl()}${path}`;

  const res = await fetchWithTimeout(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }, REQUEST_TIMEOUT_MS, `${method} ${path}`);

  if (await shouldRetryAfter401(res.status, retrying)) {
    return request<T>(method, path, body, true);
  }

  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, with401Hint(res.status, err.message), json.data);
  }

  return res.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

/** POST JSON and consume the response as a tar stream, returning each entry as
 *  { name, buffer } in arrival order. Non-2xx responses are parsed as JSON errors. */
export async function postForTarEntries(
  path: string,
  body?: unknown,
  retried = false,
): Promise<Array<{ name: string; buffer: Buffer }>> {
  const headers = await getHeaders();
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (await shouldRetryAfter401(res.status, retried)) {
    return postForTarEntries(path, body, true);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, with401Hint(res.status, err.message), json.data);
  }
  if (!res.body) throw new ApiError(500, 'EMPTY_RESPONSE', 'Server returned no body');

  const extract = tar.extract();
  const entries: Array<{ name: string; buffer: Buffer }> = [];

  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        entries.push({ name: header.name, buffer: Buffer.concat(chunks) });
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    extract.on('finish', () => resolve());
    extract.on('error', reject);
  });

  Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream).pipe(extract);
  await done;
  return entries;
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function del<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('DELETE', path, body);
}

/** Send a message via the conversation API, reusing or creating a conversation. Returns content string. */
export async function sendMessage(message: string): Promise<string> {
  const config = requireConfig();

  const useExisting = !!config.conversationGuid;
  const endpoint = useExisting
    ? `/conversations/${config.conversationGuid}/messages`
    : '/conversations';
  const body = useExisting
    ? { content: message }
    : { agentGuid: config.agentGuid, content: message, projectGuid: config.projectGuid };

  const res = await post<{
    data: {
      content: string;
      conversationGuid: string;
      costWarning?: { message: string; currentModel: string } | null;
    };
  }>(endpoint, body);

  if (res.data.conversationGuid !== config.conversationGuid) {
    saveConfig({ ...config, conversationGuid: res.data.conversationGuid });
  }

  // The server's cost-consent gate stops the agentic loop on big-build
  // requests and returns an explicit costWarning with empty content. Surface
  // it - before this the CLI printed nothing and the command silently did
  // nothing. Replying "y" (next sendMessage) consents and proceeds.
  if (res.data.costWarning && !res.data.content) {
    return res.data.costWarning.message;
  }

  return res.data.content;
}

/** Download a file as raw bytes (no JSON parsing) */
export async function download(path: string, retried = false): Promise<Buffer> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { ...clientHeaders(), 'Authorization': `Bearer ${await bearerToken()}` },
  });

  if (await shouldRetryAfter401(res.status, retried)) {
    return download(path, true);
  }
  if (!res.ok) {
    throw new ApiError(res.status, 'DOWNLOAD_ERROR', with401Hint(res.status, `Download failed: ${res.statusText}`));
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Download raw bytes plus the response headers - for binary endpoints whose
 *  metadata rides headers (e.g. `GET /projects/:guid/export`, where
 *  `X-Gip-Skipped` and the Content-Disposition filename matter to the caller).
 *  Non-2xx responses are parsed as standard JSON errors. */
export async function downloadWithHeaders(
  path: string,
  retried = false,
): Promise<{ buffer: Buffer; headers: Headers }> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { ...clientHeaders(), 'Authorization': `Bearer ${await bearerToken()}` },
  });

  if (await shouldRetryAfter401(res.status, retried)) {
    return downloadWithHeaders(path, true);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, with401Hint(res.status, err.message), json.data);
  }

  return { buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

/** POST raw bytes (e.g. a .gip bundle) and parse the JSON response, returning
 *  the HTTP status alongside it so callers can tell a clean 201 from a 207
 *  partial success. The timeout scales with the body size (same policy as the
 *  presigned PUT path) so a large-but-progressing upload isn't cut off. */
export async function postBinary<T>(
  path: string,
  body: Buffer,
  contentType = 'application/zip',
  retried = false,
): Promise<{ status: number; json: T }> {
  const url = `${baseUrl()}${path}`;
  const headers = {
    ...clientHeaders(),
    'Authorization': `Bearer ${await bearerToken()}`,
    'Content-Type': contentType,
  };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  }, putTimeoutMs(body.length), `POST ${path}`);

  if (await shouldRetryAfter401(res.status, retried)) {
    return postBinary<T>(path, body, contentType, true);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, with401Hint(res.status, err.message), json.data);
  }

  return { status: res.status, json: await res.json() as T };
}

/** Download a response as a Node.js Readable stream */
export async function downloadStream(path: string, retried = false): Promise<import('stream').Readable> {
  const { Readable } = await import('stream');
  const url = `${baseUrl()}${path}`;
  // Bound time-to-first-byte only: abort if no RESPONSE within the header window,
  // then clear the timer so the (possibly large) body streams without a total cap.
  // The body is guarded by an idle watchdog at the call site (sync.ts), which
  // destroys this stream - cancelling the fetch - if bytes stop flowing.
  const ac = new AbortController();
  const headerTimer = setTimeout(() => ac.abort(), DOWNLOAD_HEADER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...clientHeaders(), 'Authorization': `Bearer ${await bearerToken()}` },
      signal: ac.signal,
    });
  } catch (e: any) {
    if (ac.signal.aborted) {
      throw new ApiError(408, 'DOWNLOAD_TIMEOUT', `Download did not respond within ${DOWNLOAD_HEADER_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(headerTimer);
  }

  if (await shouldRetryAfter401(res.status, retried)) {
    return downloadStream(path, true);
  }
  if (!res.ok) {
    throw new ApiError(res.status, 'DOWNLOAD_ERROR', with401Hint(res.status, `Download failed: ${res.statusText}`));
  }

  return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
}

// A presigned PUT has no built-in deadline: `fetch` will wait forever if S3
// accepts the connection then stalls mid-body. That can't surface as a retry
// (a hang never throws), so one stalled PUT wedges an entire deploy/sync while
// it holds the project lock. Bound every PUT with a throughput-scaled deadline:
// a generous floor for tiny files plus time for the body at a conservative
// assumed-minimum rate, so a genuinely-progressing large upload survives but a
// true stall aborts and lets withRetry() retry it.
const PUT_TIMEOUT_FLOOR_MS = 120_000;        // 2 min minimum, regardless of size
const PUT_MIN_BYTES_PER_SEC = 256 * 1024;    // assume the link sustains ≥256 KB/s

export function putTimeoutMs(contentLength: number): number {
  return Math.max(PUT_TIMEOUT_FLOOR_MS, Math.ceil(contentLength / PUT_MIN_BYTES_PER_SEC) * 1000);
}

/**
 * PUT raw bytes to a presigned URL (no auth header - the URL is signed).
 * Supports a Buffer or a Readable stream body. Returns the response ETag header
 * (without quotes), used for multipart upload completion.
 */
export async function putToPresignedUrl(
  url: string, body: Buffer | NodeJS.ReadableStream, contentLength: number, contentType?: string,
): Promise<string> {
  const { Readable } = await import('stream');
  const headers: Record<string, string> = { 'Content-Length': String(contentLength) };
  if (contentType) headers['Content-Type'] = contentType;

  // Node fetch needs duplex='half' for streaming bodies; Buffer must be
  // narrowed to Uint8Array for the BodyInit type.
  const isStream = typeof (body as NodeJS.ReadableStream).pipe === 'function';
  const fetchBody: BodyInit = isStream
    ? (Readable.toWeb(body as import('stream').Readable) as unknown as ReadableStream)
    : new Uint8Array(body as Buffer);

  const timeoutMs = putTimeoutMs(contentLength);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(timeoutMs),
      ...(isStream ? ({ duplex: 'half' } as RequestInit) : {}),
    });
  } catch (err) {
    // A timeout aborts with a TimeoutError/AbortError. Surface it as a 408 so
    // withRetry() treats it as transient and retries the PUT.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ApiError(408, 'S3_UPLOAD_TIMEOUT',
        `S3 PUT stalled (no completion in ${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, 'S3_UPLOAD', `S3 PUT failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const etag = (res.headers.get('etag') ?? '').replace(/^"|"$/g, '');
  return etag;
}

let accountSlugCache: string | null = null;

/** Fetch the current user's account_slug, cached for the CLI process lifetime. */
export async function getAccountSlug(): Promise<string> {
  if (accountSlugCache !== null) return accountSlugCache;
  const res = await get<{ data: { accountSlug: string } }>('/users/me');
  accountSlugCache = res.data.accountSlug;
  return accountSlugCache;
}

/** Unauthenticated request (for login/verify, and anonymous-visitor calls like
 *  `fn call --anon`). extraHeaders lets callers attach non-auth headers such as
 *  X-App-Token; no Authorization header is ever sent. */
export async function publicPost<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...clientHeaders(), 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, err.message, json.data);
  }

  return res.json() as Promise<T>;
}

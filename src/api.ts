import { getAuth, refreshTokenIfNeeded } from './auth.js';
import { getConfig, getApiBaseOverride, requireConfig, saveConfig } from './config.js';

export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getHeaders(): Promise<Record<string, string>> {
  await refreshTokenIfNeeded();
  const auth = getAuth();
  if (!auth) throw new Error('Not authenticated. Run: gipity login');
  return {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
  };
}

function baseUrl(): string {
  return getApiBaseOverride() || getConfig()?.apiBase || 'https://a.gipity.ai';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await getHeaders();
  const url = `${baseUrl()}${path}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, err.message);
  }

  return res.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
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
    data: { content: string; conversationGuid: string };
  }>(endpoint, body);

  if (res.data.conversationGuid !== config.conversationGuid) {
    saveConfig({ ...config, conversationGuid: res.data.conversationGuid });
  }

  return res.data.content;
}

/** Download a file as raw bytes (no JSON parsing) */
export async function download(path: string): Promise<Buffer> {
  await refreshTokenIfNeeded();
  const auth = getAuth();
  if (!auth) throw new Error('Not authenticated. Run: gipity login');

  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${auth.accessToken}` },
  });

  if (!res.ok) {
    throw new ApiError(res.status, 'DOWNLOAD_ERROR', `Download failed: ${res.statusText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Download a response as a Node.js Readable stream */
export async function downloadStream(path: string): Promise<import('stream').Readable> {
  const { Readable } = await import('stream');
  await refreshTokenIfNeeded();
  const auth = getAuth();
  if (!auth) throw new Error('Not authenticated. Run: gipity login');

  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${auth.accessToken}` },
  });

  if (!res.ok) {
    throw new ApiError(res.status, 'DOWNLOAD_ERROR', `Download failed: ${res.statusText}`);
  }

  return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
}

/**
 * PUT raw bytes to a presigned URL (no auth header — the URL is signed).
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

  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: fetchBody,
    ...(isStream ? ({ duplex: 'half' } as RequestInit) : {}),
  });

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

/** Unauthenticated request (for login/verify) */
export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const err = json.error || { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, err.code, err.message);
  }

  return res.json() as Promise<T>;
}

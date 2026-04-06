import { getAuth, refreshTokenIfNeeded } from './auth.js';
import { getConfig, requireConfig, saveConfig } from './config.js';

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
  const config = getConfig();
  return config?.apiBase || 'https://a.gipity.ai';
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

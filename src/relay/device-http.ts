/**
 * Device-authenticated HTTP client. Shared by the relay daemon and the
 * capture hook runner (lifecycle hooks that mirror terminal `gipity
 * claude` transcripts into the server).
 *
 * The device bearer token lives in `~/.gipity/relay.json` (loaded via
 * `state.getDevice()`). It's minted when the user pairs this machine via
 * `gipity login` / the relay onboarding flow and never leaves this file
 * or the Authorization header.
 */
import { resolveApiBase } from '../config.js';
import * as state from './state.js';

export function apiBase(): string {
  return resolveApiBase();
}

export function deviceToken(): string {
  const d = state.getDevice();
  if (!d) throw new Error('No device registered. Run: gipity login');
  return d.token;
}

/** Forward an outer signal's abort into an inner controller exactly once,
 *  and return a disposer that always detaches the listener. Prevents
 *  listener leaks on long-lived shutdown signals across many calls. */
export function bridgeAbort(outer: AbortSignal, inner: AbortController): () => void {
  if (outer.aborted) {
    inner.abort(outer.reason);
    return () => {};
  }
  const onAbort = (): void => { inner.abort(outer.reason); };
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

/** Device-auth binary POST — raw bytes body (no JSON/base64 wrapping).
 *  Used by the transcript-media upload, where the whole point is that the
 *  image travels as bytes instead of base64. */
export async function deviceFetchBinary(
  method: string,
  path: string,
  body: Buffer,
  contentType: string,
  timeoutMs?: number,
): Promise<Response> {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort('timeout'), timeoutMs) : null;
  try {
    return await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${deviceToken()}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(body),
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Device-auth HTTP helper. Sends `Authorization: Bearer <device-token>`
 *  + `Content-Type: application/json` to the configured API base. */
export async function deviceFetch(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort('timeout'), timeoutMs) : null;

  const detach = (signal && controller) ? bridgeAbort(signal, controller) : null;

  try {
    return await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${deviceToken()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal ?? signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (detach) detach();
  }
}

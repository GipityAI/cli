import http from 'http';

/**
 * Outbound networking setup for the CLI process: honor the standard proxy
 * environment variables, and make a failed request say where it was going and
 * why.
 *
 * Node's fetch() ignores HTTP_PROXY / HTTPS_PROXY unless the process starts with
 * NODE_USE_ENV_PROXY=1, so in a sandbox whose only way out is a proxy (curl
 * works, it reads those vars) every command died with a bare "fetch failed"
 * that named neither the host nor the cause (cli#191). Node 24 can switch the
 * same built-in proxy support on at runtime with http.setGlobalProxyFromEnv(),
 * which also respects NO_PROXY.
 */

const PROXY_VARS = { 'https:': ['HTTPS_PROXY', 'https_proxy'], 'http:': ['HTTP_PROXY', 'http_proxy'] } as const;

/** The proxy URL the environment configures (credentials stripped): the one
 *  for `protocol` requests, or any when no protocol is given. */
export function configuredProxy(env: NodeJS.ProcessEnv = process.env, protocol?: string): string | null {
  const vars = protocol === 'https:' || protocol === 'http:'
    ? PROXY_VARS[protocol]
    : [...PROXY_VARS['https:'], ...PROXY_VARS['http:']];
  for (const k of vars) {
    const v = env[k];
    if (!v) continue;
    try {
      const u = new URL(v);
      return `${u.protocol}//${u.host}`;
    } catch {
      return v;
    }
  }
  return null;
}

type SetGlobalProxyFromEnv = (env?: NodeJS.ProcessEnv) => unknown;

/** Route fetch()/http(s) through the env-configured proxy. Returns whether the
 *  proxy is now in effect (false when none is configured, or this Node predates
 *  runtime proxy support - the network error then says how to enable it). */
export function enableEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!configuredProxy(env)) return false;
  const set = (http as unknown as { setGlobalProxyFromEnv?: SetGlobalProxyFromEnv }).setGlobalProxyFromEnv;
  if (typeof set !== 'function') return env.NODE_USE_ENV_PROXY === '1';
  set(env);
  return true;
}

/** Turn undici's bare `TypeError: fetch failed` into one naming the target
 *  origin and the underlying cause (DNS, refused, reset, proxy...). Keeps the
 *  `fetch failed` prefix, the TypeError type and the original `cause`, so
 *  callers that branch on them still work. Only the origin is named: presigned
 *  URLs carry credentials in their query string. */
export function describeFetchError(err: unknown, input: unknown, proxyActive: boolean, env: NodeJS.ProcessEnv = process.env): unknown {
  if (!(err instanceof TypeError) || err.message !== 'fetch failed') return err;
  let origin = 'the server';
  let protocol: string | undefined;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    origin = url.origin;
    protocol = url.protocol;
  } catch { /* keep the generic name */ }

  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code && cause.message && !cause.message.includes(cause.code)
    ? `${cause.code}: ${cause.message}`
    : cause?.message || cause?.code || 'no further detail';
  const proxy = configuredProxy(env, protocol);
  const route = proxy && proxyActive ? ` via proxy ${proxy}` : '';
  let hint = '';
  if (proxy && !proxyActive) {
    hint = ` A proxy is configured (${proxy}) but this Node version can't apply it at runtime: re-run with NODE_USE_ENV_PROXY=1, or use Node 24+.`;
  } else if (!proxy) {
    hint = ' Check the network; if outbound traffic must go through a proxy, set HTTPS_PROXY.';
  }
  return new TypeError(`fetch failed: could not reach ${origin}${route} (${why}).${hint}`, { cause: cause ?? err });
}

/** Install both behaviors for this process. Call once, before any request. */
export function installNetworking(): void {
  const proxyActive = enableEnvProxy();
  const base = globalThis.fetch;
  globalThis.fetch = async function fetchWithContext(input, init) {
    try {
      return await base(input, init);
    } catch (err) {
      throw describeFetchError(err, input, proxyActive);
    }
  } as typeof fetch;
}

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/**
 * Reusable in-process HTTP mock for CLI happy-path tests.
 *
 * Each test:
 *   - registers handlers via `mock.on('GET /path', response)` (response can be a value or a function of req)
 *   - invokes the CLI via runCliAsync with `--api-base http://127.0.0.1:<port>`
 *   - asserts on stdout/exit code
 *
 * The universal canary is to also assert `stdout` does NOT contain "undefined"
 * - which catches the kind of field-name mismatch we hit with credits/logs.
 */

export type MockHandler =
  | { status?: number; body?: unknown; raw?: string | Buffer; contentType?: string }
  | ((req: { method: string; url: string; body: unknown; headers: Record<string, string | string[] | undefined> }) =>
      Promise<{ status?: number; body?: unknown; raw?: string | Buffer; contentType?: string }> |
      { status?: number; body?: unknown; raw?: string | Buffer; contentType?: string });

export class MockServer {
  private routes = new Map<string, MockHandler>();
  private server: Server | null = null;
  private requestLog: Array<{ method: string; url: string; body: unknown }> = [];
  apiBase = '';

  /** Register (or overwrite) a route handler. Key format: 'METHOD /path' (path is exact match, no patterns). */
  on(methodAndPath: string, handler: MockHandler): this {
    this.routes.set(methodAndPath.trim(), handler);
    return this;
  }

  /** Clear all registered routes (call between tests if reusing the server). */
  reset(): void {
    this.routes.clear();
    this.requestLog = [];
  }

  /** All requests received since the last reset, in arrival order. */
  requests(): Array<{ method: string; url: string; body: unknown }> {
    return this.requestLog.slice();
  }

  async start(): Promise<string> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const body = await readBody(req);
      this.requestLog.push({ method, url, body });

      // Try exact match first.
      const key = `${method} ${url}`;
      let handler = this.routes.get(key);

      // Then try query-stripped path (so `/credits/usage?limit=20` matches `GET /credits/usage`).
      if (!handler) {
        const path = url.split('?')[0];
        handler = this.routes.get(`${method} ${path}`);
      }

      // Finally, a per-method wildcard (`mock.on('GET *', …)`) acts as a catch-all
      // for any unmatched path - used to simulate static-host SPA fallbacks where
      // unknown paths return 200 with index.html instead of a 404.
      if (!handler) {
        handler = this.routes.get(`${method} *`);
      }

      if (!handler) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no mock for ${method} ${url}` } }));
        return;
      }

      const resolved = typeof handler === 'function'
        ? await handler({ method, url, body, headers: req.headers })
        : handler;
      const status = resolved.status ?? 200;
      const contentType = resolved.contentType ?? 'application/json';
      res.statusCode = status;
      res.setHeader('content-type', contentType);
      if (resolved.raw !== undefined) {
        res.end(resolved.raw);
      } else {
        res.end(JSON.stringify(resolved.body ?? {}));
      }
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    this.apiBase = `http://127.0.0.1:${port}`;
    return this.apiBase;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = null;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Convenience: start a fresh server with no routes; tests call `mock.on(...)` per scenario. */
export async function startMockServer(): Promise<MockServer> {
  const mock = new MockServer();
  await mock.start();
  return mock;
}

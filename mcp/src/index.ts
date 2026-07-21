#!/usr/bin/env node
/**
 * gipity-mcp - MCP server for the Gipity platform (https://gipity.ai).
 *
 * Eight resource-grouped tools over the platform REST API at a.gipity.ai.
 * Deliberately smaller than the `gipity` CLI (30+ commands): interactive
 * flows (login, chat, log tailing) and admin ops stay CLI-only.
 *
 * Auth: GIPITY_TOKEN env var (a long-lived agent token from
 * `gipity token create`, recommended), else the session token in
 * ~/.gipity/auth.json written by `gipity login` (expires; no refresh here).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.1.0';
const API_BASE = process.env.GIPITY_API_BASE?.trim() || 'https://a.gipity.ai';

// ── auth ─────────────────────────────────────────────────────────────────────

function resolveToken(): string {
  const env = process.env.GIPITY_TOKEN?.trim();
  if (env) return env;
  const dir = process.env.GIPITY_DIR || join(homedir(), '.gipity');
  try {
    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    if (typeof auth.accessToken === 'string' && auth.accessToken) return auth.accessToken;
  } catch { /* fall through to the error below */ }
  throw new Error(
    'No Gipity credentials. Set GIPITY_TOKEN to an agent token (create one with `gipity token create`) or run `gipity login`.',
  );
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${resolveToken()}`,
      'Content-Type': 'application/json',
      'User-Agent': `gipity-mcp/${VERSION}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    let msg = json?.error?.message || `Gipity API error (HTTP ${res.status})`;
    if (res.status === 401) {
      msg += ' - token invalid or expired. Set GIPITY_TOKEN to a long-lived agent token: `gipity token create`.';
    }
    throw new Error(msg);
  }
  return json?.data ?? json;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ── server ───────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'gipity', version: VERSION });

const PROJECT_GUID = z.string().describe("Project guid, e.g. 'p_565vtr3q' (find via the project tool's list action)");

server.registerTool('project', {
  description: 'Manage Gipity projects. Actions: list, get, create, rename, delete. A project is a deployable app workspace with its own files, functions, and databases.',
  inputSchema: {
    action: z.enum(['list', 'get', 'create', 'rename', 'delete']),
    project_guid: PROJECT_GUID.optional(),
    name: z.string().optional().describe('Project name (create/rename)'),
    slug: z.string().optional().describe('URL slug (create); lowercase letters, digits, hyphens'),
  },
}, async ({ action, project_guid, name, slug }) => {
  switch (action) {
    case 'list': return ok(await api('GET', '/projects?limit=1000'));
    case 'get': return ok(await api('GET', `/projects/${req(project_guid, 'project_guid')}`));
    case 'create': return ok(await api('POST', '/projects', { name: req(name, 'name'), slug: req(slug, 'slug') }));
    case 'rename': return ok(await api('PUT', `/projects/${req(project_guid, 'project_guid')}`, { name: req(name, 'name') }));
    case 'delete': return ok(await api('DELETE', `/projects/${req(project_guid, 'project_guid')}`));
  }
});

server.registerTool('deploy', {
  description: "Deploy a project's synced files to Gipity hosting. target 'dev' -> dev.gipity.ai (default), 'prod' -> app.gipity.ai. Runs the multi-phase pipeline (files, database migrations, functions) and returns the live URL. Files must already be in the project (push via the file tool or `gipity sync`).",
  inputSchema: {
    project_guid: PROJECT_GUID,
    target: z.enum(['dev', 'prod']).default('dev'),
    force: z.boolean().optional().describe('Re-run all phases even if checksums are unchanged'),
    only: z.array(z.string()).optional().describe("Run only these phases, e.g. ['database']"),
  },
}, async ({ project_guid, target, force, only }) =>
  ok(await api('POST', `/projects/${project_guid}/deploy`, { target, force, only })));

server.registerTool('database', {
  description: "Project databases (Gipity DB). Actions: list, query (raw SQL incl. DDL), create, drop. 'query' without 'database' uses the project's first database.",
  inputSchema: {
    action: z.enum(['list', 'query', 'create', 'drop']),
    project_guid: PROJECT_GUID,
    sql: z.string().optional().describe('SQL to run (query)'),
    database: z.string().optional().describe('Database name (query); defaults to the first one'),
    name: z.string().optional().describe('Database name (create/drop)'),
  },
}, async ({ action, project_guid, sql, database, name }) => {
  switch (action) {
    case 'list': return ok(await api('GET', `/projects/${project_guid}/databases`));
    case 'query': {
      let db = database;
      if (!db) {
        const dbs = await api('GET', `/projects/${project_guid}/databases`) as Array<{ friendlyName: string }>;
        if (!dbs?.length) throw new Error('Project has no databases. Create one first (action: create).');
        db = dbs[0].friendlyName;
      }
      return ok(await api('POST', `/projects/${project_guid}/db/query`, { sql: req(sql, 'sql'), database: db }));
    }
    case 'create': return ok(await api('POST', `/projects/${project_guid}/db/manage`, { action: 'create', name: req(name, 'name') }));
    case 'drop': return ok(await api('POST', `/projects/${project_guid}/db/manage`, { action: 'drop', name: req(name, 'name') }));
  }
});

server.registerTool('function', {
  description: "Deployed serverless functions. Actions: list, call (POST JSON params, returns the function's result), logs (recent invocations), delete. Functions deploy from the project's functions/ dir via the deploy tool.",
  inputSchema: {
    action: z.enum(['list', 'call', 'logs', 'delete']),
    project_guid: PROJECT_GUID,
    name: z.string().optional().describe('Function name (call/logs/delete)'),
    params: z.record(z.unknown()).optional().describe('JSON body for call'),
    limit: z.number().int().positive().max(100).optional().describe('Max log entries (logs), default 20'),
  },
}, async ({ action, project_guid, name, params, limit }) => {
  switch (action) {
    case 'list': return ok(await api('GET', `/projects/${project_guid}/functions`));
    case 'call': return ok(await api('POST', `/api/${project_guid}/fn/${req(name, 'name')}`, params ?? {}));
    case 'logs': return ok(await api('GET', `/projects/${project_guid}/functions/${req(name, 'name')}/logs?limit=${limit ?? 20}`));
    case 'delete': return ok(await api('DELETE', `/projects/${project_guid}/functions/${req(name, 'name')}`));
  }
});

server.registerTool('memory', {
  description: 'Project memory: persistent topic-keyed notes shared by every agent working on the project. Actions: list (topics with content), write (upsert a topic), delete.',
  inputSchema: {
    action: z.enum(['list', 'write', 'delete']),
    project_guid: PROJECT_GUID,
    topic: z.string().optional().describe('Topic key (write/delete)'),
    content: z.string().optional().describe('Content to store (write)'),
  },
}, async ({ action, project_guid, topic, content }) => {
  switch (action) {
    case 'list': return ok(await api('GET', `/projects/${project_guid}/memory`));
    case 'write': return ok(await api('PUT', `/projects/${project_guid}/memory/${encodeURIComponent(req(topic, 'topic'))}`, { content: req(content, 'content') }));
    case 'delete': return ok(await api('DELETE', `/projects/${project_guid}/memory/${encodeURIComponent(req(topic, 'topic'))}`));
  }
});

server.registerTool('workflow', {
  description: 'Workflow automations (cron or manually triggered multi-step pipelines). Actions: list (all accounts workflows), get, run (fire now), runs (execution history), enable, disable. Workflow guids look like wf_xxxxxxxx.',
  inputSchema: {
    action: z.enum(['list', 'get', 'run', 'runs', 'enable', 'disable']),
    workflow_guid: z.string().optional().describe('Workflow guid (all actions except list)'),
    limit: z.number().int().positive().max(100).optional().describe('Max runs to return (runs)'),
  },
}, async ({ action, workflow_guid, limit }) => {
  const g = () => req(workflow_guid, 'workflow_guid');
  switch (action) {
    case 'list': return ok(await api('GET', '/workflows'));
    case 'get': return ok(await api('GET', `/workflows/${g()}`));
    case 'run': return ok(await api('POST', `/workflows/${g()}/run`, {}));
    case 'runs': return ok(await api('GET', `/workflows/${g()}/runs?limit=${limit ?? 20}`));
    case 'enable': return ok(await api('PUT', `/workflows/${g()}`, { is_active: true }));
    case 'disable': return ok(await api('PUT', `/workflows/${g()}`, { is_active: false }));
  }
});

server.registerTool('file', {
  description: "Project files (synced cloud workspace the deploys ship from). Actions: list (dir listing), tree (recursive), read (text content), push (write a text file), url (public link), delete. Paths are project-relative like 'src/index.html'.",
  inputSchema: {
    action: z.enum(['list', 'tree', 'read', 'push', 'url', 'delete']),
    project_guid: PROJECT_GUID,
    path: z.string().optional().describe('Project-relative path (all actions except a root list/tree)'),
    content: z.string().optional().describe('UTF-8 text content (push)'),
  },
}, async ({ action, project_guid, path, content }) => {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  switch (action) {
    case 'list': return ok(await api('GET', `/projects/${project_guid}/files${q}`));
    case 'tree': return ok(await api('GET', `/projects/${project_guid}/files/tree${q}`));
    case 'read': return ok(await api('GET', `/projects/${project_guid}/files/read?path=${encodeURIComponent(req(path, 'path'))}`));
    case 'url': return ok(await api('GET', `/projects/${project_guid}/files/url?path=${encodeURIComponent(req(path, 'path'))}`));
    case 'delete': return ok(await api('DELETE', `/projects/${project_guid}/files?path=${encodeURIComponent(req(path, 'path'))}`));
    case 'push': {
      const p = req(path, 'path');
      const bytes = Buffer.from(req(content, 'content'), 'utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const init: any = await api('POST', `/projects/${project_guid}/files/upload-init`, {
        path: p, size: bytes.length, sha256, mime: 'text/plain',
      });
      if (init?.already_current) return ok({ path: p, unchanged: true, version: init.server_version });
      if (init?.method !== 'PUT' || !init?.url) {
        throw new Error(`Unexpected upload-init response (method: ${init?.method ?? 'none'}); file too large for the MCP push path - use \`gipity sync\`.`);
      }
      const put = await fetch(init.url, { method: 'PUT', body: bytes });
      if (!put.ok) throw new Error(`S3 upload failed (HTTP ${put.status})`);
      const done = await api('POST', `/projects/${project_guid}/files/upload-complete`, { upload_guid: init.upload_guid });
      return ok({ path: p, ...(done as object) });
    }
  }
});

server.registerTool('sandbox', {
  description: "Run JavaScript, Python, or Bash in the project's cloud sandbox (Docker; pandas, ffmpeg, ImageMagick etc. preinstalled; no network). The sandbox sees the project's synced files under /work/ and writes outputs back to the project.",
  inputSchema: {
    project_guid: PROJECT_GUID,
    code: z.string().describe('Source code to execute'),
    language: z.enum(['javascript', 'python', 'bash']),
    timeout: z.number().int().positive().max(600).default(60).describe('Seconds before the run is killed'),
  },
}, async ({ project_guid, code, language, timeout }) =>
  ok(await api('POST', `/projects/${project_guid}/sandbox/execute`, { code, language, timeout })));

// ── helpers / startup ────────────────────────────────────────────────────────

function req<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === '') throw new Error(`Missing required parameter: ${name}`);
  return v;
}

const transport = new StdioServerTransport();
await server.connect(transport);

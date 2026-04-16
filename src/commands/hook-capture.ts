/**
 * Hidden subcommand invoked by Claude Code hooks (see setup.ts HOOKS_SETTINGS).
 * Reads Claude's hook JSON on stdin and POSTs a capture event to Gipity.
 *
 * The target conversation is identified by the `GIPITY_CONVERSATION_GUID`
 * env var, which `gipity claude` exports before spawning Claude Code.
 * Every capture event is tagged with that conv_guid — no server-side
 * placeholder adoption, no guessing.
 *
 * Must never fail loudly — a hook that errors would degrade Claude Code's
 * UX. All errors are swallowed (optionally logged to
 * .gipity/hook-capture.log for debugging).
 */
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, appendFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { getConfig } from '../config.js';
import { getAuth } from '../auth.js';
import { post } from '../api.js';

type HookPayload = Record<string, any>;

function readStdin(): Promise<string> {
  return new Promise((r) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => r(data));
    process.stdin.on('error', () => r(data));
  });
}

function debugLog(msg: string): void {
  if (!process.env.GIPITY_HOOK_DEBUG) return;
  try {
    const cfg = getConfig();
    if (!cfg) return;
    const logPath = resolve(process.cwd(), '.gipity', 'hook-capture.log');
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

const TTY = !!(process.stderr as any).isTTY;
const dim = (s: string) => TTY ? `\x1b[2m${s}\x1b[0m` : s;
const cyan = (s: string) => TTY ? `\x1b[36m${s}\x1b[0m` : s;
const red = (s: string) => TTY ? `\x1b[31m${s}\x1b[0m` : s;

function hhmmss(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function friendlyLabel(path: string): string {
  const m = path.match(/\/remote-sessions\/[^/]+\/(.+)$/);
  return m ? m[1] : path;
}

function summarize(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, any>;
  if (typeof b.prompt === 'string') {
    const p = b.prompt.replace(/\s+/g, ' ').trim();
    return p.length > 80 ? `"${p.slice(0, 77)}…"` : `"${p}"`;
  }
  if (typeof b.tool_name === 'string') return b.tool_name;
  if (Array.isArray(b.entries)) return `${b.entries.length} transcript entr${b.entries.length === 1 ? 'y' : 'ies'}`;
  if (typeof b.trigger === 'string') return b.trigger;
  if (typeof b.source === 'string') return b.source;
  return '';
}

async function safePost(path: string, body: unknown): Promise<void> {
  const label = friendlyLabel(path);
  const detail = summarize(body);
  process.stderr.write(`${dim(hhmmss())} ${cyan('↗ gipity')}  ${label}${detail ? '  ' + dim(detail) : ''}\n`);
  try {
    await post(path, body);
  } catch (err: any) {
    process.stderr.write(`${dim(hhmmss())} ${red('✗ gipity')}  ${label}  ${dim(err?.message || String(err))}\n`);
    debugLog(`POST ${path} failed: ${err?.message || err}`);
  }
}

function offsetPath(sessionId: string): string {
  return resolve(process.cwd(), '.gipity', 'transcripts', `${sessionId}.offset`);
}

function readOffset(sessionId: string): number {
  try {
    return parseInt(readFileSync(offsetPath(sessionId), 'utf-8'), 10) || 0;
  } catch { return 0; }
}

function writeOffset(sessionId: string, offset: number): void {
  const p = offsetPath(sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(offset));
}

/** Parse JSONL delta from transcript_path starting at stored offset. */
function readTranscriptDelta(transcriptPath: string, sessionId: string): { entries: any[]; newOffset: number } {
  if (!existsSync(transcriptPath)) return { entries: [], newOffset: 0 };
  const size = statSync(transcriptPath).size;
  let offset = readOffset(sessionId);
  if (offset > size) offset = 0; // regressed — rescan
  if (offset === size) return { entries: [], newOffset: offset };

  const fd = readFileSync(transcriptPath);
  const slice = fd.slice(offset).toString('utf-8');
  const lines = slice.split('\n').filter((l) => l.trim());
  const entries: any[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip partial */ }
  }
  return { entries, newOffset: size };
}

/** Preflight: hooks are no-ops when we're not in a Gipity project, not
 *  authed, or (crucially) when the parent `gipity claude` never exported
 *  a conv_guid (unpaired device, failed create, etc.). Without the
 *  conv_guid there is no conversation to attach events to. */
function preflight(): { convGuid: string } | null {
  if (!getConfig()) return null;
  if (!getAuth()) return null;
  const convGuid = process.env.GIPITY_CONVERSATION_GUID;
  if (!convGuid) return null;
  return { convGuid };
}

async function handleStart(payload: HookPayload, convGuid: string): Promise<void> {
  const { session_id, cwd, source } = payload;
  if (!session_id) return;
  // Attach this Claude Code run's session_id to the conv. Idempotent
  // server-side; harmless to call multiple times (e.g. after --resume).
  await safePost(`/remote-sessions/${encodeURIComponent(convGuid)}/attach-session`, {
    session_id,
    cwd: cwd || process.cwd(),
    source: source || 'startup',
  });
}

async function handlePrompt(payload: HookPayload, convGuid: string): Promise<void> {
  const { prompt } = payload;
  await safePost(`/remote-sessions/${encodeURIComponent(convGuid)}/prompt`, {
    prompt: prompt || '',
    ts: new Date().toISOString(),
  });
}

async function handleTool(payload: HookPayload, convGuid: string): Promise<void> {
  const { tool_name, tool_input, tool_response } = payload;
  if (!tool_name) return;
  await safePost(`/remote-sessions/${encodeURIComponent(convGuid)}/tool`, {
    tool_name,
    tool_input: tool_input ?? null,
    tool_response: tool_response ?? null,
  });
}

async function handleStop(payload: HookPayload, convGuid: string): Promise<void> {
  const { session_id, transcript_path } = payload;
  if (!session_id || !transcript_path) return;
  const { entries, newOffset } = readTranscriptDelta(transcript_path, session_id);
  if (entries.length === 0) return;
  await safePost(`/remote-sessions/${encodeURIComponent(convGuid)}/transcript`, { entries });
  writeOffset(session_id, newOffset);
}

async function handleEnd(_payload: HookPayload, convGuid: string): Promise<void> {
  await safePost(`/remote-sessions/${encodeURIComponent(convGuid)}/end`, {});
}

async function handleCompact(payload: HookPayload, convGuid: string): Promise<void> {
  const { trigger } = payload;
  await safePost(`/remote-sessions/${encodeURIComponent(convGuid)}/compact`, {
    trigger: trigger || 'auto',
  });
}

async function run(event: string): Promise<void> {
  const pre = preflight();
  if (!pre) return;

  const raw = await readStdin();
  let payload: HookPayload;
  try { payload = JSON.parse(raw); } catch { debugLog(`bad JSON on ${event}`); return; }

  switch (event) {
    case 'start':   return handleStart(payload, pre.convGuid);
    case 'prompt':  return handlePrompt(payload, pre.convGuid);
    case 'tool':    return handleTool(payload, pre.convGuid);
    case 'stop':    return handleStop(payload, pre.convGuid);
    case 'end':     return handleEnd(payload, pre.convGuid);
    case 'compact': return handleCompact(payload, pre.convGuid);
  }
}

export const hookCaptureCommand = new Command('hook-capture')
  .description('Internal: capture Claude Code hook events and forward to Gipity')
  .argument('<event>', 'hook event: start|prompt|tool|stop|end|compact')
  .action(async (event: string) => {
    await run(event);
    // Always succeed quietly — hooks must not surface errors to Claude Code.
    process.exit(0);
  });

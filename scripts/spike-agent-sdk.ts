/**
 * M4 spike: verify @anthropic-ai/claude-agent-sdk viability for the relay
 * session pool (long-lived Claude Code process per active conversation).
 *
 * Measures / verifies, in order:
 *   1. Cold-start latency of turn 1 (process spawn → result).
 *   2. Hot follow-up latency of turn 2 (send → result) - the Phase 2 payoff.
 *   3. Idle footprint: RSS of the CLI subprocess tree sampled over an idle
 *      window between turns.
 *   4. interrupt(): stops a long turn, process + session survive, and the
 *      next turn still has full context.
 *   5. Session id stability across turns within one process.
 *   6. close() → process exits; then `resume` of the same session id from a
 *      fresh one-shot query still has context (cold-path interop).
 *   7. Logs every SDK message type seen (adapter-parity survey vs
 *      relay/stream-json.ts).
 *
 * Run: npx tsx scripts/spike-agent-sdk.ts   (needs a logged-in `claude`)
 * Dev-only; not shipped. Results feed the M5 go/no-go.
 */
import { query, type Query, type SDKUserMessage, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const IDLE_SAMPLE_SECONDS = Number(process.env.SPIKE_IDLE_SECONDS || 45);

// ─── push-style input generator ────────────────────────────────────────
function makeInput() {
  const queue: SDKUserMessage[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  async function* gen(): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      while (queue.length > 0) yield queue.shift()!;
      await new Promise<void>(r => { notify = r; });
    }
  }
  return {
    stream: gen(),
    push(text: string) {
      queue.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      });
      notify?.(); notify = null;
    },
    end() { done = true; notify?.(); notify = null; },
  };
}

// ─── process-tree RSS ──────────────────────────────────────────────────
function childTreeRss(): { pids: number[]; totalKb: number } {
  // All descendants of this process (the SDK's claude subprocess + its kids).
  const out = execSync(`ps -eo pid,ppid,rss,comm`).toString().trim().split('\n').slice(1)
    .map(l => l.trim().split(/\s+/))
    .map(([pid, ppid, rss, ...comm]) => ({ pid: +pid, ppid: +ppid, rss: +rss, comm: comm.join(' ') }));
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of out) {
      if (mine.has(p.ppid) && !mine.has(p.pid)) { mine.add(p.pid); grew = true; }
    }
  }
  const kids = out.filter(p => mine.has(p.pid) && p.pid !== process.pid);
  return { pids: kids.map(k => k.pid), totalKb: kids.reduce((s, k) => s + k.rss, 0) };
}

const seenTypes = new Map<string, number>();
function note(m: SDKMessage) {
  const key = (m as any).subtype ? `${m.type}/${(m as any).subtype}` : m.type;
  seenTypes.set(key, (seenTypes.get(key) ?? 0) + 1);
}

/** Consume messages until the next `result`, returning it + latency.
 *  Uses explicit .next() - `return`ing out of a `for await` would call the
 *  generator's .return() and CLOSE the SDK session (that exact footgun is
 *  why the session pool must own a single long-lived consumer loop). */
async function untilResult(q: Query, t0: number): Promise<{ ms: number; result: any }> {
  for (;;) {
    const { value: m, done } = await q.next();
    if (done) throw new Error('stream ended without a result');
    note(m);
    if (m.type === 'system' && (m as any).subtype === 'init') {
      log(`  init: session_id=${(m as any).session_id}`);
    }
    if (m.type === 'result') {
      return { ms: Date.now() - t0, result: m };
    }
  }
}

function log(s: string) { console.log(`[spike ${new Date().toISOString().slice(11, 19)}] ${s}`); }

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'sdk-spike-'));
  log(`cwd=${cwd}`);

  const input = makeInput();
  const q = query({
    prompt: input.stream,
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'SPIKE MODE: answer as tersely as possible.' },
    },
  });

  // 1. Cold start
  let t0 = Date.now();
  input.push('Reply with exactly: READY');
  const turn1 = await untilResult(q, t0);
  const sessionId: string = (turn1.result as any).session_id;
  log(`turn1 (cold): ${turn1.ms}ms  result="${(turn1.result as any).result}"  session=${sessionId}`);

  // 3. Idle footprint while the process waits between turns
  log(`idle-sampling child tree for ${IDLE_SAMPLE_SECONDS}s…`);
  const samples: number[] = [];
  for (let i = 0; i < IDLE_SAMPLE_SECONDS / 5; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const { pids, totalKb } = childTreeRss();
    samples.push(totalKb);
    log(`  idle rss: ${(totalKb / 1024).toFixed(1)} MB across ${pids.length} proc(s)`);
  }

  // 2. Hot follow-up
  t0 = Date.now();
  input.push('What word did you just reply with? Answer with that word only.');
  const turn2 = await untilResult(q, t0);
  log(`turn2 (hot): ${turn2.ms}ms  result="${(turn2.result as any).result}"  session=${(turn2.result as any).session_id}`);
  if ((turn2.result as any).session_id !== sessionId) log('  !! session id CHANGED between turns');
  if (!/READY/i.test((turn2.result as any).result ?? '')) log('  !! hot turn lost context');

  // 4. Interrupt a long turn
  t0 = Date.now();
  input.push('Count from 1 to 2000, one number per line. No other text.');
  // Consume until we see the turn actually generating (first assistant/stream
  // evt), then interrupt. Explicit .next() - see untilResult.
  for (;;) {
    const { value: m, done } = await q.next();
    if (done) throw new Error('stream ended before the long turn started');
    note(m);
    if (m.type === 'assistant' || m.type === 'stream_event') break;
  }
  log(`interrupting mid-turn at +${Date.now() - t0}ms…`);
  const ti = Date.now();
  await q.interrupt();
  log(`interrupt() resolved in ${Date.now() - ti}ms`);
  // Drain to the interrupted turn's result (if one is emitted).
  const drained = await Promise.race([
    untilResult(q, ti).then(r => ({ kind: 'result', r })),
    new Promise<{ kind: 'timeout' }>(res => setTimeout(() => res({ kind: 'timeout' }), 15000)),
  ]);
  log(`post-interrupt: ${drained.kind === 'result' ? `result subtype=${(drained as any).r.result.subtype}` : 'no result within 15s'}`);
  const alive = childTreeRss();
  log(`process tree after interrupt: ${alive.pids.length} proc(s), ${(alive.totalKb / 1024).toFixed(1)} MB`);

  // Context after interrupt
  t0 = Date.now();
  input.push('In one short sentence: what was I asking you to do just before this message?');
  const turn4 = await untilResult(q, t0);
  log(`turn4 (post-interrupt): ${turn4.ms}ms  result="${(turn4.result as any).result}"`);
  if ((turn4.result as any).session_id !== sessionId) log('  !! session id changed after interrupt');

  // 6. Close → process exits
  input.end();
  q.close();
  await new Promise(r => setTimeout(r, 2500));
  const after = childTreeRss();
  log(`after close(): ${after.pids.length} child proc(s) remain (${(after.totalKb / 1024).toFixed(1)} MB)`);

  // Resume interop: fresh one-shot query resuming the same session
  t0 = Date.now();
  const q2 = query({
    prompt: 'What was the exact word of your very first reply in this session? Answer with that word only.',
    options: {
      cwd,
      resume: sessionId,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });
  for (;;) {
    const { value: m, done } = await q2.next();
    if (done) break;
    note(m);
    if (m.type === 'result') {
      log(`resume (cold, one-shot): ${Date.now() - t0}ms  result="${(m as any).result}"  session=${(m as any).session_id}`);
      if (!/READY/i.test((m as any).result ?? '')) log('  !! resumed session lost context');
      break;
    }
  }

  log(`idle RSS samples (MB): ${samples.map(s => (s / 1024).toFixed(0)).join(', ')}`);
  log(`message types seen: ${[...seenTypes.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`);
  log('SPIKE COMPLETE');
  process.exit(0);
}

main().catch(err => { console.error('[spike] FAILED:', err); process.exit(1); });

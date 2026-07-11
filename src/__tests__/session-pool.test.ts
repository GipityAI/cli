/**
 * SessionPool unit tests - a fake query factory stands in for the Agent SDK
 * (no `claude` binary, no SDK). Verifies turn lifecycle, hot reuse, LRU
 * eviction, idle sweep, interrupt-then-feed, and error handling.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SessionPool, PoolFullError, type QueryLike, type QueryParams } from '../relay/session-pool.js';

const noopLog = () => {};

/** A controllable fake Query. Emits an init (with a session id), then relays
 *  scripted turns: each pushed user message produces an assistant + a result,
 *  unless `hang` is set (then it waits for interrupt). */
class FakeQuery implements QueryLike {
  private out: any[] = [];
  private notify: (() => void) | null = null;
  private closed = false;
  private inputDone = false;
  interrupted = 0;
  models: (string | undefined)[] = [];
  turnsSeen = 0;
  constructor(private opts: { sessionId: string; hang?: boolean; input: AsyncIterable<any> }) {
    this.pump();
  }
  private emit(m: any) { this.out.push(m); this.notify?.(); this.notify = null; }
  private async pump() {
    this.emit({ type: 'system', subtype: 'init', session_id: this.opts.sessionId, cwd: '/x' });
    for await (const userMsg of this.opts.input) {
      this.turnsSeen++;
      const text = userMsg?.message?.content?.[0]?.text ?? '';
      this.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text.slice(0, 20)}` }] }, session_id: this.opts.sessionId, parent_tool_use_id: null });
      if (this.opts.hang) {
        // Wait until interrupted, then emit an error result.
        await new Promise<void>(r => { this.onInterrupt = r; });
        this.emit({ type: 'result', subtype: 'error_during_execution', session_id: this.opts.sessionId });
      } else {
        this.emit({ type: 'result', subtype: 'success', session_id: this.opts.sessionId, result: `done:${text.slice(0, 20)}` });
      }
    }
    this.inputDone = true;
    this.notify?.(); this.notify = null;
  }
  private onInterrupt: (() => void) | null = null;
  async next(): Promise<IteratorResult<any>> {
    for (;;) {
      if (this.out.length) return { value: this.out.shift(), done: false };
      if (this.closed || this.inputDone) return { value: undefined, done: true };
      await new Promise<void>(r => { this.notify = r; });
    }
  }
  async interrupt(): Promise<unknown> { this.interrupted++; this.onInterrupt?.(); this.onInterrupt = null; return undefined; }
  async setModel(m?: string): Promise<void> { this.models.push(m); }
  close(): void { this.closed = true; this.notify?.(); this.notify = null; }
}

function makeFactory(opts: { hang?: boolean } = {}) {
  const created: FakeQuery[] = [];
  let n = 0;
  const factory = (params: QueryParams): QueryLike => {
    const q = new FakeQuery({ sessionId: `sess-${++n}`, hang: opts.hang, input: params.prompt });
    created.push(q);
    return q;
  };
  return { factory, created };
}

/** Drain a turn: collect onMessage events + the resolved result. */
async function runTurn(pool: SessionPool, convGuid: string, message: string, extra: Record<string, unknown> = {}) {
  const msgs: any[] = [];
  const res = await pool.runTurn({
    convGuid, cwd: '/x', message, freshOptions: {}, onMessage: (m: any) => msgs.push(m), ...extra,
  } as any);
  return { res, msgs };
}

describe('SessionPool', () => {
  it('runs a turn: emits init+assistant+result and resolves done with sessionId', async () => {
    const { factory, created } = makeFactory();
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    const { res, msgs } = await runTurn(pool, 'c1', 'hello');
    assert.equal(res.outcome, 'done');
    assert.equal(res.sessionId, 'sess-1');
    assert.equal(res.wasHot, false); // cold - first turn
    assert.ok(msgs.some(m => m.type === 'assistant'));
    assert.equal(created.length, 1);
    pool.shutdown();
  });

  it('reuses a live session for a follow-up (hot) and reports wasHot', async () => {
    const { factory, created } = makeFactory();
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    const first = await runTurn(pool, 'c1', 'one');
    assert.equal(first.res.wasHot, false);
    assert.equal(pool.stateFor('c1'), 'hot');
    const second = await runTurn(pool, 'c1', 'two');
    assert.equal(second.res.wasHot, true);
    assert.equal(created.length, 1, 'same session reused - no second process');
    assert.equal(created[0].turnsSeen, 2);
    pool.shutdown();
  });

  it('setModel is called on a hot turn when the model changes', async () => {
    const { factory, created } = makeFactory();
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    await runTurn(pool, 'c1', 'one', { model: 'claude-a' });
    await runTurn(pool, 'c1', 'two', { model: 'claude-b' });
    assert.deepEqual(created[0].models, ['claude-b']);
    pool.shutdown();
  });

  it('LRU: evicts the oldest idle session past the cap', async () => {
    const { factory, created } = makeFactory();
    const pool = new SessionPool({ queryFactory: factory, log: noopLog, maxSessions: 2 });
    await runTurn(pool, 'c1', 'a');
    await new Promise(r => setTimeout(r, 5));
    await runTurn(pool, 'c2', 'b');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(pool.size(), 2);
    await runTurn(pool, 'c3', 'c'); // over cap → evict c1 (oldest idle)
    assert.equal(pool.size(), 2);
    assert.equal(pool.stateFor('c1'), 'cold');
    assert.equal(pool.stateFor('c3'), 'hot');
    pool.shutdown();
  });

  it('idle sweep closes sessions past the hot window', async () => {
    const { factory } = makeFactory();
    const pool = new SessionPool({ queryFactory: factory, log: noopLog, hotWindowMs: 30, sweepIntervalMs: 10 });
    await runTurn(pool, 'c1', 'a');
    assert.equal(pool.stateFor('c1'), 'hot');
    await new Promise(r => setTimeout(r, 80));
    assert.equal(pool.stateFor('c1'), 'cold', 'swept after hot window');
    pool.shutdown();
  });

  it('interrupt-then-feed: a message during a running turn interrupts it, then runs', async () => {
    const { factory, created } = makeFactory({ hang: true });
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    // Start a hanging turn (won't resolve until interrupted).
    const running = runTurn(pool, 'c1', 'long one');
    // Give the turn a tick to become 'running'.
    await new Promise(r => setTimeout(r, 20));
    assert.equal(pool.stateFor('c1'), 'running');
    // A second turn interrupts the first, then runs (also hangs, so we
    // interrupt it too to let the test finish).
    const second = runTurn(pool, 'c1', 'urgent two');
    const firstRes = await running;
    assert.equal(firstRes.res.outcome, 'cancelled', 'first turn interrupted');
    assert.ok(created[0].interrupted >= 1);
    assert.equal(created.length, 1, 'same session reused, not respawned');
    // The second turn is now running on the same session; interrupt to finish.
    await new Promise(r => setTimeout(r, 20));
    await pool.interrupt('c1');
    const secondRes = await second;
    assert.equal(secondRes.res.outcome, 'cancelled');
    assert.equal(secondRes.res.wasHot, true, 'second turn reused the live session');
    pool.shutdown();
  });

  it('does not double-interrupt: a follow-up after a cancel interrupts at most once', async () => {
    // Regression: a rapid follow-up sent while an interrupt is still settling
    // must not fire a SECOND interrupt() - the SDK would drop the freshly-fed
    // message as still-queued (observed live: the follow-up came back cancelled).
    const { factory, created } = makeFactory({ hang: true });
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    const running = runTurn(pool, 'c1', 'long');
    await new Promise(r => setTimeout(r, 20));
    // Simulate the cancel poller interrupting first...
    await pool.interrupt('c1');
    // ...then a follow-up arrives before the turn has drained. interrupt-then-
    // feed must NOT call interrupt() again.
    const followUp = runTurn(pool, 'c1', 'follow up');
    await running;
    assert.equal(created[0].interrupted, 1, 'exactly one interrupt, not two');
    // Clean up the (also-hanging) follow-up turn.
    await new Promise(r => setTimeout(r, 20));
    await pool.interrupt('c1');
    await followUp;
    pool.shutdown();
  });

  it('explicit interrupt() cancels the running turn and keeps the session', async () => {
    const { factory, created } = makeFactory({ hang: true });
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    const running = runTurn(pool, 'c1', 'long');
    await new Promise(r => setTimeout(r, 20));
    const ok = await pool.interrupt('c1');
    assert.equal(ok, true);
    const res = await running;
    assert.equal(res.res.outcome, 'cancelled');
    assert.equal(created[0].interrupted, 1);
    pool.shutdown();
  });

  it('PoolFullError when all sessions are running and cap is reached', async () => {
    const { factory } = makeFactory({ hang: true });
    const pool = new SessionPool({ queryFactory: factory, log: noopLog, maxSessions: 1 });
    const running = runTurn(pool, 'c1', 'hang'); // occupies the only slot, running
    await new Promise(r => setTimeout(r, 20));
    await assert.rejects(
      () => pool.runTurn({ convGuid: 'c2', cwd: '/x', message: 'x', freshOptions: {}, onMessage: () => {} } as any),
      (e: Error) => e instanceof PoolFullError,
    );
    await pool.interrupt('c1');
    await running;
    pool.shutdown();
  });

  it('liveConversations reflects hot/running state for the heartbeat', async () => {
    const { factory } = makeFactory();
    const pool = new SessionPool({ queryFactory: factory, log: noopLog });
    await runTurn(pool, 'c1', 'a');
    const live = pool.liveConversations();
    assert.equal(live.length, 1);
    assert.equal(live[0].convGuid, 'c1');
    assert.equal(live[0].state, 'hot');
    pool.shutdown();
  });
});

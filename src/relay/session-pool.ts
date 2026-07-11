/**
 * Phase 2: long-lived Claude Code sessions per active conversation, via the
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`). A follow-up message is fed
 * into the already-running process instead of spawning a fresh `gipity
 * claude -p` each time - so it skips project sync + cold start, and an
 * interrupt is a clean `.interrupt()` that stops the turn while keeping the
 * session (no kill + `--resume`-from-transcript).
 *
 * Cost control (the spike measured ~300 MB RSS per idle session): an LRU cap
 * on live sessions + a short hot window after the last turn, then the process
 * exits and the conversation falls back to a cold `resume` on its next
 * message. Idle conversations beyond the window cost nothing.
 *
 * This module owns ONLY the SDK lifecycle + pool mechanics. The daemon wires
 * the message stream into the existing ingest/ack/progress pipeline via the
 * `onMessage` callback, so redaction, dedup, and the web live view are
 * unchanged from the spawn path. The SDK is reached through an injectable
 * `queryFactory` so tests never need the real SDK or a `claude` binary.
 */

/** The slice of the SDK's `Query` we depend on. Kept minimal so a fake in
 *  tests is trivial and so an SDK version bump can't silently change a wide
 *  surface under us. */
export interface QueryLike extends AsyncIterator<any> {
  next(): Promise<IteratorResult<any>>;
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  close(): void;
}

export interface QueryParams {
  /** Push-style async iterable of SDK user messages. */
  prompt: AsyncIterable<any>;
  options: Record<string, unknown>;
}

export type QueryFactory = (params: QueryParams) => QueryLike;

/** Build one SDK user-message object (the shape the SDK's streaming input
 *  expects). Exported so the daemon and tests build turns identically. */
export function userMessage(text: string): any {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

export type TurnOutcome = 'done' | 'error' | 'cancelled';

export interface RunTurnParams {
  convGuid: string;
  cwd: string;
  /** Already-wrapped prompt text (project context / resume framing applied
   *  by the daemon, same as the spawn path). */
  message: string;
  model?: string | null;
  /** SDK options the daemon supplies for a FRESH session (permissionMode,
   *  systemPrompt, env, pathToClaudeCodeExecutable, resume, …). Ignored when
   *  reusing a live session (those are fixed at creation). */
  freshOptions: Record<string, unknown>;
  /** Called for every SDK message in this turn (init, assistant, result, …).
   *  The daemon maps these into ingest entries + progress. */
  onMessage: (msg: any) => void;
}

export interface RunTurnResult {
  outcome: TurnOutcome;
  error?: string;
  /** Claude Code session id for this conversation (stable across turns). */
  sessionId?: string;
  /** True when this turn started a new process (cold), false when it reused
   *  a live session (hot). Drives the relay-state indicator. */
  wasHot: boolean;
}

/** Thrown by `runTurn` when the pool is full of RUNNING sessions and can't
 *  make room - the daemon catches this and falls back to a legacy spawn for
 *  this one dispatch, so a busy pool never blocks work. */
export class PoolFullError extends Error {
  constructor() { super('session pool full (all sessions running)'); this.name = 'PoolFullError'; }
}

interface Turn {
  onMessage: (msg: any) => void;
  resolve: (r: RunTurnResult) => void;
  reject: (e: Error) => void;
  interruptRequested: boolean;
  wasHot: boolean;
  /** Resolves when this turn settles (result / session end). Used to
   *  serialize a follow-up turn behind an interrupt of the current one. */
  done: Promise<void>;
  markDone: () => void;
}

interface Session {
  convGuid: string;
  cwd: string;
  query: QueryLike;
  /** Push a user message into the session's input stream. */
  push: (text: string) => void;
  /** Close the input generator so the consumer loop ends and the process exits. */
  endInput: () => void;
  state: 'idle' | 'running';
  sessionId?: string;
  model?: string | null;
  lastActivityAt: number;
  /** The turn currently being consumed, or null between turns. */
  current: Turn | null;
  /** Resolves when the consumer loop exits (process gone). */
  consumerDone: Promise<void>;
  dead: boolean;
}

export interface PoolDeps {
  queryFactory: QueryFactory;
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: Record<string, unknown>) => void;
  /** Live-session hot window after the last turn ends, ms. */
  hotWindowMs?: number;
  /** Max concurrent live sessions (LRU). */
  maxSessions?: number;
  /** Idle-sweep tick, ms. */
  sweepIntervalMs?: number;
  /** Fired whenever a conversation's live-session state changes (created,
   *  running↔idle, closed) - drives an immediate relay-state heartbeat so
   *  the web indicator flips hot/cold without waiting for the 60s tick. */
  onStateChange?: () => void;
}

export type SessionStateKind = 'hot' | 'running' | 'cold';

export class SessionPool {
  private sessions = new Map<string, Session>();
  private readonly deps: Required<PoolDeps>;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: PoolDeps) {
    this.deps = {
      hotWindowMs: 5 * 60_000,
      maxSessions: 3,
      sweepIntervalMs: 30_000,
      onStateChange: () => {},
      ...deps,
    };
    this.sweepTimer = setInterval(() => this.sweepIdle(), this.deps.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private stateChanged(): void {
    try { this.deps.onStateChange(); } catch { /* best-effort */ }
  }

  /** State of a conversation for the web indicator: `hot` (live idle session -
   *  next message is fast), `running` (a turn is in flight), or `cold` (no
   *  live session - next message cold-starts). */
  stateFor(convGuid: string): SessionStateKind {
    const s = this.sessions.get(convGuid);
    if (!s || s.dead) return 'cold';
    return s.state === 'running' ? 'running' : 'hot';
  }

  /** convGuids with a live (hot or running) session - for the daemon's
   *  session-state heartbeat to the server. */
  liveConversations(): Array<{ convGuid: string; state: SessionStateKind }> {
    const out: Array<{ convGuid: string; state: SessionStateKind }> = [];
    for (const s of this.sessions.values()) {
      if (!s.dead) out.push({ convGuid: s.convGuid, state: s.state === 'running' ? 'running' : 'hot' });
    }
    return out;
  }

  size(): number { return [...this.sessions.values()].filter(s => !s.dead).length; }

  async runTurn(p: RunTurnParams): Promise<RunTurnResult> {
    let session = this.sessions.get(p.convGuid);
    if (session?.dead) { this.sessions.delete(p.convGuid); session = undefined; }

    // Interrupt-then-feed: a message arriving while a turn is still running
    // for this conversation interrupts it and waits for it to settle, so the
    // new turn runs against a clean, idle session. (The daemon's own
    // kill-on-new usually beats us to it; this is the belt.)
    if (session && session.state === 'running' && session.current) {
      const prev = session.current;
      // Only fire interrupt() if the turn isn't ALREADY being interrupted (a
      // user cancel may have just done so). A second interrupt() racing the
      // feed can cancel the message we're about to push - the SDK treats a
      // freshly-queued user message as still-queued and drops it. So we mark,
      // interrupt at most once, then wait for the turn to fully settle.
      if (!prev.interruptRequested) {
        prev.interruptRequested = true;
        try { await session.query.interrupt(); } catch { /* fall through - wait anyway */ }
      }
      await prev.done;
      if (session.dead) { this.sessions.delete(p.convGuid); session = undefined; }
    }

    const wasHot = !!session && session.state === 'idle';
    if (!session) session = await this.createSession(p);

    let markDone!: () => void;
    const done = new Promise<void>(r => { markDone = r; });
    return new Promise<RunTurnResult>((resolve, reject) => {
      const turn: Turn = { onMessage: p.onMessage, resolve, reject, interruptRequested: false, wasHot, done, markDone };
      session!.current = turn;
      session!.state = 'running';
      session!.lastActivityAt = Date.now();
      if (wasHot && p.model !== undefined && p.model !== session!.model) {
        session!.model = p.model;
        session!.query.setModel(p.model ?? undefined).catch(err =>
          this.deps.log('warn', 'setModel failed', { convGuid: p.convGuid, err: err?.message }));
      }
      this.stateChanged(); // → running
      session!.push(p.message);
    });
  }

  /** Interrupt the running turn for a conversation (user cancel or a
   *  when:'now' send). Stops the turn; the session stays alive and idle. */
  async interrupt(convGuid: string): Promise<boolean> {
    const s = this.sessions.get(convGuid);
    if (!s || s.dead || s.state !== 'running' || !s.current) return false;
    s.current.interruptRequested = true;
    try {
      await s.query.interrupt();
      this.deps.log('info', 'interrupted running turn', { convGuid });
      return true;
    } catch (err: any) {
      this.deps.log('warn', 'interrupt failed', { convGuid, err: err?.message });
      return false;
    }
  }

  /** Close idle sessions past the hot window. Running sessions are never
   *  swept (a legitimate long turn keeps the session alive). */
  sweepIdle(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.dead) { this.sessions.delete(s.convGuid); continue; }
      if (s.state === 'idle' && now - s.lastActivityAt > this.deps.hotWindowMs) {
        this.deps.log('info', 'closing idle session (hot window elapsed)', { convGuid: s.convGuid });
        this.closeSession(s);
      }
    }
  }

  /** Close all sessions - daemon shutdown. */
  shutdown(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    for (const s of this.sessions.values()) this.closeSession(s);
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async createSession(p: RunTurnParams): Promise<Session> {
    // LRU room-making: evict the oldest IDLE session. If none is idle, the
    // pool is saturated with running turns - refuse so the daemon falls back
    // to a legacy spawn rather than blocking.
    while (this.size() >= this.deps.maxSessions) {
      const oldestIdle = [...this.sessions.values()]
        .filter(s => !s.dead && s.state === 'idle')
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
      if (!oldestIdle) throw new PoolFullError();
      this.deps.log('info', 'evicting oldest idle session (LRU cap)', { convGuid: oldestIdle.convGuid });
      this.closeSession(oldestIdle);
    }

    // Push-style input generator: the session's turns are fed as user
    // messages over its lifetime.
    let notify: (() => void) | null = null;
    const pending: any[] = [];
    let ended = false;
    async function* input(): AsyncGenerator<any> {
      for (;;) {
        while (pending.length > 0) yield pending.shift();
        if (ended) return;
        await new Promise<void>(r => { notify = r; });
      }
    }

    const query = this.deps.queryFactory({ prompt: input(), options: p.freshOptions });

    const session: Session = {
      convGuid: p.convGuid,
      cwd: p.cwd,
      query,
      push: (text: string) => { pending.push(userMessage(text)); notify?.(); notify = null; },
      endInput: () => { ended = true; notify?.(); notify = null; },
      state: 'idle',
      model: p.model ?? null,
      lastActivityAt: Date.now(),
      current: null,
      consumerDone: Promise.resolve(),
      dead: false,
    };
    this.sessions.set(p.convGuid, session);
    session.consumerDone = this.consume(session);
    return session;
  }

  /** The single owned consumer loop for a session. Uses explicit `.next()`
   *  (NOT `for await`, whose early break calls `.return()` and would close
   *  the SDK session), routes each message to the current turn, and resolves
   *  a turn on its `result` message. */
  private async consume(s: Session): Promise<void> {
    try {
      for (;;) {
        const { value: msg, done } = await s.query.next();
        if (done) break;
        if (msg?.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
          s.sessionId = msg.session_id;
        }
        const turn = s.current;
        if (turn) {
          try { turn.onMessage(msg); } catch (err: any) {
            this.deps.log('warn', 'onMessage threw', { convGuid: s.convGuid, err: err?.message });
          }
          if (msg?.type === 'result') this.finishTurn(s, turn, msg);
        }
      }
      // Loop ended cleanly (input closed / process exited). Fail any turn
      // still open so the daemon acks it instead of hanging.
      this.failOpenTurn(s, 'session ended');
    } catch (err: any) {
      this.deps.log('error', 'session consumer loop errored', { convGuid: s.convGuid, err: err?.message });
      this.failOpenTurn(s, err?.message || 'session error');
    } finally {
      s.dead = true;
      this.sessions.delete(s.convGuid);
      try { s.query.close(); } catch { /* already closed */ }
      this.stateChanged(); // → cold (process gone)
    }
  }

  private finishTurn(s: Session, turn: Turn, result: any): void {
    if (s.current !== turn) return;
    s.current = null;
    s.state = 'idle';
    s.lastActivityAt = Date.now();
    const isErr = result?.subtype && result.subtype !== 'success';
    const outcome: TurnOutcome = turn.interruptRequested ? 'cancelled' : (isErr ? 'error' : 'done');
    turn.resolve({
      outcome,
      error: outcome === 'error' ? (result?.subtype || 'error_during_execution') : undefined,
      sessionId: s.sessionId,
      wasHot: turn.wasHot,
    });
    turn.markDone();
    this.stateChanged(); // running → hot (idle)
  }

  private failOpenTurn(s: Session, reason: string): void {
    const turn = s.current;
    if (!turn) return;
    s.current = null;
    // An interrupt that ends the whole session still counts as cancelled.
    if (turn.interruptRequested) {
      turn.resolve({ outcome: 'cancelled', sessionId: s.sessionId, wasHot: turn.wasHot });
    } else {
      turn.resolve({ outcome: 'error', error: reason, sessionId: s.sessionId, wasHot: turn.wasHot });
    }
    turn.markDone();
  }

  private closeSession(s: Session): void {
    s.dead = true;
    this.sessions.delete(s.convGuid);
    try { s.endInput(); } catch { /* noop */ }
    try { s.query.close(); } catch { /* noop */ }
    this.stateChanged(); // → cold
  }
}

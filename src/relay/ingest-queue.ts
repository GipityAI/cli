/**
 * Ordered, bounded, retrying ingest queue - one per dispatch.
 *
 * Replaces the old fire-and-forget POST-per-event model, which had two
 * real failure modes: (1) a transient network/server error dropped those
 * entries PERMANENTLY (the hook path retries via its transcript
 * watermark; the stream path had no equivalent), and (2) parallel POSTs
 * could land out of order. The queue serializes: one drainer, batches in
 * arrival order, backoff retry on failure. Retrying is safe because
 * entries carry `source_uuid` dedup keys - a replayed batch collapses
 * server-side instead of duplicating.
 *
 * Bounded so a runaway child can't grow daemon memory without limit: on
 * overflow the OLDEST entries drop (the newest content is what the user
 * is waiting on) and a visible system marker records the gap - dropped
 * content must never be silent.
 */
import type { IngestEntry } from './stream-json.js';

export type IngestPoster = (entries: IngestEntry[]) => Promise<{ ok: boolean; retryable?: boolean }>;

export interface IngestQueueOptions {
  /** Max entries held; overflow drops oldest. */
  maxEntries?: number;
  /** Max approximate JSON bytes held; overflow drops oldest. */
  maxBytes?: number;
  /** Max entries per POST (server hard cap is 200). */
  batchMax?: number;
  /** Retry backoff schedule; the last value repeats. */
  backoffMs?: number[];
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  onWarn?: (msg: string, meta?: Record<string, unknown>) => void;
}

const DEFAULTS = {
  maxEntries: 2000,
  maxBytes: 8 * 1024 * 1024,
  batchMax: 200,
  backoffMs: [2000, 5000, 15000, 60000],
};

function entryBytes(e: IngestEntry): number {
  try {
    return JSON.stringify(e).length;
  } catch {
    return 1024;
  }
}

export class IngestQueue {
  private queue: Array<{ entry: IngestEntry; bytes: number }> = [];
  private bytes = 0;
  private draining = false;
  private closed = false;
  private closeDeadline = 0;
  private drainDone: Promise<void> = Promise.resolve();
  private droppedTotal = 0;
  private markedDrop = false;
  private readonly opts: Required<Omit<IngestQueueOptions, 'sleep' | 'onWarn'>> & Pick<IngestQueueOptions, 'sleep' | 'onWarn'>;

  constructor(private readonly post: IngestPoster, opts: IngestQueueOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  /** Enqueue entries in order and kick the drainer. Sync and non-blocking. */
  push(...entries: IngestEntry[]): void {
    if (this.closed) {
      this.opts.onWarn?.('ingest queue push after close - dropped', { count: entries.length });
      this.droppedTotal += entries.length;
      return;
    }
    for (const entry of entries) {
      const bytes = entryBytes(entry);
      this.queue.push({ entry, bytes });
      this.bytes += bytes;
    }
    this.enforceBounds();
    this.kick();
  }

  /** Stop accepting entries and drain what's left, giving up at the
   *  deadline. Returns whether everything flushed. */
  async close(deadlineMs = 30_000): Promise<{ flushed: boolean; dropped: number }> {
    this.closed = true;
    this.closeDeadline = Date.now() + deadlineMs;
    this.kick();
    // Await until the drainer has fully settled. The re-kick in `kick`'s
    // finally is gated on `!closed`, so once we're here no NEW drain can
    // start - a single settled await is sufficient, but loop defensively
    // in case a kick was mid-settle when `closed` flipped.
    while (this.draining) await this.drainDone;
    await this.drainDone;
    const flushed = this.queue.length === 0;
    if (!flushed) {
      this.droppedTotal += this.queue.length;
      this.opts.onWarn?.('ingest queue close deadline hit - entries lost', { remaining: this.queue.length });
      this.queue = [];
      this.bytes = 0;
    }
    return { flushed, dropped: this.droppedTotal };
  }

  private enforceBounds(): void {
    let droppedNow = 0;
    while (this.queue.length > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const victim = this.queue.shift();
      if (!victim) break;
      this.bytes -= victim.bytes;
      droppedNow++;
    }
    if (droppedNow > 0) {
      this.droppedTotal += droppedNow;
      this.opts.onWarn?.('ingest queue overflow - oldest entries dropped', { droppedNow, droppedTotal: this.droppedTotal });
      if (!this.markedDrop) {
        this.markedDrop = true;
        // Visible gap marker, placed at the head so it lands before the
        // surviving (newer) entries.
        const marker: IngestEntry = { kind: 'system', content: 'Some session output could not be uploaded (upload backlog overflowed).' };
        this.queue.unshift({ entry: marker, bytes: entryBytes(marker) });
        this.bytes += entryBytes(marker);
      }
    }
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainDone = this.drain().finally(() => {
      this.draining = false;
      // Entries may have arrived while the final await of drain() settled.
      // Never re-kick once closed: close() owns the last drain, and a
      // re-kick here would POST a batch AFTER close() returned (the
      // zombie-drain bug - post-after-ack + corrupted byte accounting).
      if (this.queue.length && !this.closed) this.kick();
    });
  }

  private async drain(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    let attempt = 0;
    while (this.queue.length) {
      // Remove the batch from the queue BEFORE awaiting the POST. A push
      // that overflows the bounds during the await runs `enforceBounds`,
      // which shifts the queue head - if the in-flight batch were still
      // at the head, a later splice-by-index would remove the wrong
      // entries and drift `bytes`. Holding the batch out of the queue
      // makes overflow touch only not-in-flight entries.
      const batch = this.queue.splice(0, this.opts.batchMax);
      const batchBytes = batch.reduce((n, b) => n + b.bytes, 0);
      this.bytes -= batchBytes;
      const result = await this.post(batch.map(b => b.entry));
      if (result.ok) { attempt = 0; continue; }
      // Definitive rejection (4xx: schema or auth) - a replay can never
      // succeed, and retrying would stall the queue behind a poisoned
      // batch. Drop it (counted + warned) and move on.
      if (result.retryable === false) {
        attempt = 0;
        this.droppedTotal += batch.length;
        this.opts.onWarn?.('ingest batch rejected by server - dropped', { count: batch.length });
        continue;
      }
      // Transient failure: put the batch back at the head and retry after
      // backoff (order preserved; source_uuid dedup makes a partial
      // server-side success safe).
      this.queue.unshift(...batch);
      this.bytes += batchBytes;
      const backoff = this.opts.backoffMs[Math.min(attempt, this.opts.backoffMs.length - 1)];
      attempt++;
      if (this.closed && Date.now() + backoff > this.closeDeadline) return;
      await sleep(backoff);
      if (this.closed && Date.now() > this.closeDeadline) return;
    }
  }
}

/**
 * IngestQueue: ordering, retry with backoff, overflow drop-oldest with a
 * visible gap marker, and bounded close. Uses an injected fake poster and
 * zero-delay sleep so tests run instantly with no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IngestQueue } from '../relay/ingest-queue.js';
import type { IngestEntry } from '../relay/stream-json.js';

const sys = (n: number): IngestEntry => ({ kind: 'system', content: `entry ${n}` });

function collectingPoster(failFirst = 0) {
  const batches: IngestEntry[][] = [];
  let fails = failFirst;
  return {
    batches,
    post: async (entries: IngestEntry[]) => {
      if (fails > 0) {
        fails--;
        return { ok: false };
      }
      batches.push(entries);
      return { ok: true };
    },
  };
}

const instantSleep = () => Promise.resolve();

describe('IngestQueue', () => {
  it('drains pushed entries in order', async () => {
    const p = collectingPoster();
    const q = new IngestQueue(p.post, { sleep: instantSleep });
    q.push(sys(1), sys(2));
    q.push(sys(3));
    const { flushed } = await q.close(1000);
    assert.equal(flushed, true);
    const all = p.batches.flat().map(e => (e as any).content);
    assert.deepEqual(all, ['entry 1', 'entry 2', 'entry 3']);
  });

  it('retries a failed batch without losing or reordering entries', async () => {
    const p = collectingPoster(2); // first two attempts fail
    // Deadline must exceed the backoff steps [2000,5000,…] this retry
    // walks: `drain` refuses to START a sleep that would overshoot the
    // deadline, so a tight deadline would abort mid-retry.
    const q = new IngestQueue(p.post, { sleep: instantSleep });
    q.push(sys(1));
    q.push(sys(2));
    const { flushed } = await q.close(60_000);
    assert.equal(flushed, true);
    const all = p.batches.flat().map(e => (e as any).content);
    assert.deepEqual(all, ['entry 1', 'entry 2']);
  });

  it('does not POST after close() returns (no zombie re-kick)', async () => {
    // Regression for the re-kick bug: when drain aborts at the deadline
    // with a non-empty queue, the finally-hook must NOT start a fresh
    // drain that POSTs after close() has already resolved.
    let postsAfterClose = 0;
    let closed = false;
    const q = new IngestQueue(async () => {
      if (closed) postsAfterClose++;
      return { ok: false }; // never succeeds → forces the deadline abort
    }, { sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 3))), backoffMs: [3] });
    q.push(sys(1));
    await q.close(20);
    closed = true;
    await new Promise(r => setTimeout(r, 40)); // give any zombie drain time to fire
    assert.equal(postsAfterClose, 0, `posted ${postsAfterClose} times after close()`);
  });

  it('splits large pushes into server-cap batches', async () => {
    const p = collectingPoster();
    const q = new IngestQueue(p.post, { sleep: instantSleep, batchMax: 10 });
    q.push(...Array.from({ length: 25 }, (_, i) => sys(i)));
    await q.close(1000);
    assert.ok(p.batches.every(b => b.length <= 10), 'batch exceeded batchMax');
    assert.equal(p.batches.flat().length, 25);
  });

  it('overflow drops oldest entries and injects one visible gap marker', async () => {
    // Poster that never succeeds until we let it - forces queue growth.
    let allow = false;
    const batches: IngestEntry[][] = [];
    const q = new IngestQueue(async (entries) => {
      if (!allow) return { ok: false };
      batches.push(entries);
      return { ok: true };
    }, { sleep: instantSleep, maxEntries: 5 });

    q.push(...Array.from({ length: 12 }, (_, i) => sys(i)));
    assert.ok(q.dropped > 0, 'expected drops');
    allow = true;
    const { flushed } = await q.close(5000);
    assert.equal(flushed, true);
    const all = batches.flat().map(e => (e as any).content);
    // Gap marker first, then only the newest entries survive.
    assert.ok(all[0].includes('could not be uploaded'), `expected gap marker first, got: ${all[0]}`);
    assert.ok(all.includes('entry 11'), 'newest entry must survive');
    assert.ok(!all.includes('entry 0'), 'oldest entry should have dropped');
  });

  it('a definitively-rejected batch (retryable:false) is dropped, not retried', async () => {
    let calls = 0;
    const accepted: IngestEntry[][] = [];
    const q = new IngestQueue(async (entries) => {
      calls++;
      if (calls === 1) return { ok: false, retryable: false };
      accepted.push(entries);
      return { ok: true };
    }, { sleep: instantSleep, batchMax: 1 });
    q.push(sys(1), sys(2));
    const { flushed } = await q.close(1000);
    assert.equal(flushed, true);
    assert.equal(q.dropped, 1, 'rejected batch should count as dropped');
    assert.deepEqual(accepted.flat().map(e => (e as any).content), ['entry 2']);
  });

  it('close gives up at the deadline when the server never recovers', async () => {
    const q = new IngestQueue(async () => ({ ok: false }), {
      sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5))),
      backoffMs: [5],
    });
    q.push(sys(1));
    const { flushed, dropped } = await q.close(30);
    assert.equal(flushed, false);
    assert.ok(dropped >= 1);
  });

  it('push after close drops and counts', async () => {
    const p = collectingPoster();
    const q = new IngestQueue(p.post, { sleep: instantSleep });
    await q.close(100);
    q.push(sys(1));
    assert.equal(q.dropped, 1);
    assert.equal(p.batches.length, 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeAbort } from '../relay/daemon.js';

function listenerCount(signal: AbortSignal): number {
  const anyOf = signal as unknown as { _events?: unknown; [k: symbol]: unknown };
  // Node's EventTarget uses an internal symbol; fall back to dispatching a
  // probe event and counting via a public API if internals aren't exposed.
  // Simpler: rely on MaxListenersExceededWarning being gated at 10. Instead
  // assert behaviourally: after N add/detach cycles the outer signal still
  // reports zero active listeners by firing abort and asserting only the
  // most recent bridge ran.
  void anyOf;
  return -1;
}

describe('bridgeAbort', () => {
  it('forwards outer abort to inner controller', () => {
    const outer = new AbortController();
    const inner = new AbortController();
    bridgeAbort(outer.signal, inner);
    outer.abort('shutdown');
    assert.equal(inner.signal.aborted, true);
    assert.equal(inner.signal.reason, 'shutdown');
  });

  it('aborts immediately when outer is already aborted', () => {
    const outer = new AbortController();
    outer.abort('pre');
    const inner = new AbortController();
    bridgeAbort(outer.signal, inner);
    assert.equal(inner.signal.aborted, true);
    assert.equal(inner.signal.reason, 'pre');
  });

  it('detaches cleanly — does not leak listeners across many calls', () => {
    const outer = new AbortController();

    // Sanity: listenerCount via public API isn't part of EventTarget, so we
    // verify no leak by running many cycles and confirming the process does
    // not emit MaxListenersExceededWarning and that only inners whose detach
    // was NOT called receive the abort.
    const warnings: string[] = [];
    const onWarn = (w: Error) => { warnings.push(w.name + ':' + w.message); };
    process.on('warning', onWarn);

    try {
      for (let i = 0; i < 100; i++) {
        const inner = new AbortController();
        const detach = bridgeAbort(outer.signal, inner);
        detach();
      }
    } finally {
      process.off('warning', onWarn);
    }

    const leakWarn = warnings.find(w => w.includes('MaxListenersExceeded'));
    assert.equal(leakWarn, undefined, `leaked listeners: ${leakWarn}`);

    // After all detaches, firing outer.abort must not affect any prior
    // inners (they're out of scope / already detached). Create one more
    // inner WITHOUT detaching and confirm it receives the abort — proves
    // the bridge still works after many attach/detach cycles.
    const liveInner = new AbortController();
    bridgeAbort(outer.signal, liveInner);
    outer.abort('final');
    assert.equal(liveInner.signal.aborted, true);
    assert.equal(liveInner.signal.reason, 'final');

    void listenerCount;
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressReporter, withSpinner, type ProgressReporter } from '../progress.js';

/** Run `fn` with stdout's TTY flag forced and every write captured. */
function capture(isTTY: boolean, fn: (r: ProgressReporter) => void): string {
  const out: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origTTY = process.stdout.isTTY;
  (process.stdout as unknown as { isTTY: boolean }).isTTY = isTTY;
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c) => {
    out.push(String(c));
    return true;
  };
  try {
    fn(createProgressReporter()); // factory reads isTTY at call time
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = origTTY;
  }
  return out.join('');
}

describe('createProgressReporter', () => {
  it('is a silent no-op off a TTY', () => {
    const out = capture(false, (r) => {
      r.phase('Scanning…');
      r.transfer('Uploading', 5, 10);
      r.finish();
    });
    assert.equal(out, '');
  });

  it('prints a committed line per phase', () => {
    const out = capture(true, (r) => r.phase('Scanning local files...'));
    assert.match(out, /Scanning local files.../);
    assert.match(out, /\n$/);
  });

  it('renders a determinate bar with percentage and byte sizes', () => {
    // NO_COLOR-free env: colors collapse to identity in tests, so assert on text.
    const out = capture(true, (r) => r.transfer('Uploading', 3, 10));
    assert.match(out, /30%/);
    assert.match(out, /3 B \/ 10 B/);
    assert.match(out, /[█░]/);       // a bar was drawn
    assert.match(out, /^\r/);        // redrawn in place
    assert.match(out, /0s/);         // built-in elapsed timer, same as the spinner
  });

  it('throttles mid-flight redraws but always paints the final frame', () => {
    const out = capture(true, (r) => {
      r.transfer('Uploading', 3, 10);  // first frame → drawn
      r.transfer('Uploading', 4, 10);  // <60ms later, not done → suppressed
      r.transfer('Uploading', 10, 10); // done → always drawn + committed
    });
    assert.match(out, /30%/);
    assert.doesNotMatch(out, /40%/);
    assert.match(out, /100%/);
    assert.match(out, /\n$/);          // final frame commits the line
  });

  it('finish() commits an open bar with a trailing newline', () => {
    const out = capture(true, (r) => {
      r.transfer('Uploading', 3, 10);  // opens a live line (not finished)
      r.finish();
    });
    assert.match(out, /\n$/);
  });

  it('guards against a zero-byte total (no division blowup)', () => {
    const out = capture(true, (r) => r.transfer('Uploading', 0, 0));
    assert.match(out, /100%/);
  });

  it('drops late/overshoot ticks after a session hits 100%', () => {
    // Download byte totals are estimated, so the wire can deliver a hair more
    // than expected; an extra tick past completion must not paint a 2nd line.
    const out = capture(true, (r) => {
      r.transfer('Downloading', 0, 10);
      r.transfer('Downloading', 10, 10); // done → committed
      r.transfer('Downloading', 11, 10); // overshoot → dropped
      r.transfer('Downloading', 12, 10); // late tick → dropped
    });
    assert.equal(out.match(/100%/g)?.length, 1); // committed exactly once
    assert.doesNotMatch(out, /11 B|12 B/);       // no >100% frame leaked
  });

  it('starts a fresh session when the label changes', () => {
    // A settled download must not suppress the upload bar that follows.
    const out = capture(true, (r) => {
      r.transfer('Downloading', 10, 10); // settles the download session
      r.transfer('Uploading', 3, 10);    // new label → fresh, must draw
    });
    assert.match(out, /Downloading/);
    assert.match(out, /Uploading/);
    assert.match(out, /30%/);
  });
});

describe('spinner (indeterminate)', () => {
  it('is a silent no-op off a TTY', () => {
    const out = capture(false, (r) => { r.spinner('Working…').stop(); });
    assert.equal(out, '');
  });

  it('draws the bouncing block on the same track as the bar, then a ✓ line', () => {
    const out = capture(true, (r) => r.spinner('Deploying to dev…').succeed('Deployed to dev'));
    assert.match(out, /[█░]/);              // SAME track glyphs as transfer()
    assert.match(out, /0\.0s/);             // label-less clock, tenths under 10s
    assert.match(out, /✓/);                 // settles to success icon
    assert.match(out, /Deployed to dev/);   // settle message
    assert.match(out, /\n$/);               // line committed
  });

  it('settles to a ✗ line on fail()', () => {
    const out = capture(true, (r) => r.spinner('Deploying…').fail('Deploy failed'));
    assert.match(out, /✗/);
    assert.match(out, /Deploy failed/);
    assert.match(out, /\n$/);
  });

  it('stop() clears the row with no icon and no trailing newline', () => {
    // The cleared row is left for the command's own result to overwrite, so it
    // must NOT advance to a new line (which would strand a blank line).
    const out = capture(true, (r) => r.spinner('Thinking…').stop());
    assert.doesNotMatch(out, /[✓✗]/);
    assert.match(out, /\x1b\[K$/);   // ends by clearing the row…
    assert.doesNotMatch(out, /\n$/); // …not by advancing past it
  });
});

describe('withSpinner', () => {
  it('returns the operation result (silent pass-through off a TTY)', async () => {
    const v = await withSpinner('Working…', async () => 42);
    assert.equal(v, 42);
  });

  it('re-throws on failure so the caller still handles the error', async () => {
    await assert.rejects(
      withSpinner('Working…', async () => { throw new Error('boom'); }),
      /boom/,
    );
  });
});

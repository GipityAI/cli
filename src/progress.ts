// ── Gipity CLI Progress Reporter ────────────────────────────────────────
// One central place for long-running terminal feedback, so commands don't
// each reinvent status lines. Three channels, one shared visual vocabulary:
//
//   phase(msg)              - a discrete step with no measurable size
//                             (scanning, hashing). Prints one committed line.
//   transfer(label, n, tot) - a DETERMINATE byte transfer. Renders a single
//                             in-place bar that fills as bytes move.
//   spinner(label)          - an INDETERMINATE wait (a server call where we
//                             can't measure bytes: deploy, generate, chat).
//                             Renders the SAME-width track as transfer(), but
//                             with a short block that bounces left↔right plus
//                             an elapsed timer, so a long wait never reads as
//                             frozen. Settles to a committed ✓/✗ line.
//
// On a non-TTY (piped output, hook-driven sync, headless -p) the reporter is a
// silent no-op - no `\r` spam in logs. Colors come from ./colors so the bar
// matches the rest of the CLI (orange fill + percentage).

import { brand, brandBold, muted, dim, success, error as clrError } from './colors.js';
import { formatSize } from './utils.js';

/** A live indeterminate spinner. Call exactly one terminal method to settle it. */
export interface SpinnerHandle {
  /** Settle with a ✓ line. `message` defaults to the spinner's label. */
  succeed(message?: string): void;
  /** Settle with a ✗ line. `message` defaults to the spinner's label. */
  fail(message?: string): void;
  /** Settle silently (just commit the line / stop animating), no icon. */
  stop(): void;
}

export interface ProgressReporter {
  /** A discrete step with no measurable progress. Commits one line. */
  phase(message: string): void;
  /** Determinate byte transfer. Cheap to call frequently - renders are throttled. */
  transfer(label: string, doneBytes: number, totalBytes: number): void;
  /** Indeterminate wait. Returns a handle; settle it with succeed/fail/stop. */
  spinner(label: string): SpinnerHandle;
  /** Settle the live line (commit a trailing newline if a bar/spinner is open). */
  finish(): void;
}

const CLEAR_TO_EOL = '\x1b[K';
const BAR_WIDTH = 18;
const RENDER_THROTTLE_MS = 60;
// Indeterminate bounce: a short block sliding across the same BAR_WIDTH track
// the determinate bar fills. Frame cadence is slow enough to read, fast enough
// to feel alive.
const SPIN_BLOCK = 5;
const SPIN_FRAME_MS = 90;

/** Compact elapsed: "8s", "1m 04s". Keeps the timer narrow and glanceable. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

class TerminalProgress implements ProgressReporter {
  /** True while an in-place transfer/spinner line is on screen and not committed. */
  private liveOpen = false;
  private lastRenderAt = 0;
  /** The label of the current transfer session; a change starts a fresh one. */
  private barLabel: string | null = null;
  /** True once the current session hit 100% - late/overshoot ticks are dropped. */
  private barSettled = false;
  /** Active indeterminate spinner timer, if any. */
  private spinTimer: ReturnType<typeof setInterval> | null = null;

  phase(message: string): void {
    this.stopSpinTimer();
    this.commitLive();
    process.stdout.write(`  ${muted(message)}\n`);
  }

  transfer(label: string, doneBytes: number, totalBytes: number): void {
    // A determinate transfer takes over the live line from any spinner.
    this.stopSpinTimer();
    // A new label begins a fresh transfer session (e.g. downloads → uploads on
    // the same reporter). Within a session, once we've drawn the 100% frame we
    // drop any further ticks - download byte totals are estimated, so the wire
    // can deliver a hair more or fewer bytes than expected and we don't want a
    // late chunk reopening a second "100%" line.
    if (label !== this.barLabel) {
      this.barLabel = label;
      this.barSettled = false;
    }
    if (this.barSettled) return;

    const finished = totalBytes > 0 && doneBytes >= totalBytes;
    // Throttle mid-flight redraws; always paint the first and final frames.
    const now = Date.now();
    if (this.liveOpen && !finished && now - this.lastRenderAt < RENDER_THROTTLE_MS) return;
    this.lastRenderAt = now;
    this.liveOpen = true;
    process.stdout.write('\r' + this.barFrame(label, doneBytes, totalBytes) + CLEAR_TO_EOL);
    if (finished) {
      this.commitLive();
      this.barSettled = true;
    }
  }

  spinner(label: string): SpinnerHandle {
    this.stopSpinTimer();
    this.commitLive();
    const startedAt = Date.now();
    let tick = 0;
    const draw = () => {
      this.liveOpen = true;
      process.stdout.write('\r' + this.spinFrame(label, tick++, Date.now() - startedAt) + CLEAR_TO_EOL);
    };
    draw();
    this.spinTimer = setInterval(draw, SPIN_FRAME_MS);
    // Don't let the animation keep the event loop (and process) alive on its own.
    this.spinTimer.unref?.();

    const settle = (icon: string | null, message?: string): void => {
      this.stopSpinTimer();
      if (this.liveOpen) process.stdout.write('\r');
      if (icon) {
        // Replace the spinner line in place with a committed ✓/✗ result line.
        const elapsed = muted(formatElapsed(Date.now() - startedAt));
        process.stdout.write(`  ${icon}  ${muted(message ?? label)}  ${elapsed}${CLEAR_TO_EOL}\n`);
      } else if (this.liveOpen) {
        // Silent stop: clear the spinner row but DON'T advance - leave the
        // cursor at column 0 so the command's own result overwrites the row
        // instead of leaving a blank line behind it.
        process.stdout.write(CLEAR_TO_EOL);
      }
      this.liveOpen = false;
    };
    return {
      succeed: (m?: string) => settle(success('✓'), m),
      fail: (m?: string) => settle(clrError('✗'), m),
      stop: () => settle(null),
    };
  }

  finish(): void {
    this.stopSpinTimer();
    this.commitLive();
  }

  private stopSpinTimer(): void {
    if (this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = null; }
  }

  private commitLive(): void {
    if (!this.liveOpen) return;
    process.stdout.write('\n');
    this.liveOpen = false;
  }

  private barFrame(label: string, done: number, total: number): string {
    const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = brand('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
    const sizes = muted(`${formatSize(done)} / ${formatSize(total)}`);
    return `  ${muted(label)}  ${bar}  ${brandBold(`${pct}%`)}  ${sizes}`;
  }

  private spinFrame(label: string, tick: number, elapsedMs: number): string {
    // Ping-pong the block's left edge between 0 and (BAR_WIDTH - SPIN_BLOCK).
    const span = BAR_WIDTH - SPIN_BLOCK;
    const cycle = span * 2;
    const phase = tick % cycle;
    const pos = phase <= span ? phase : cycle - phase;
    const bar =
      dim('░'.repeat(pos)) +
      brand('█'.repeat(SPIN_BLOCK)) +
      dim('░'.repeat(BAR_WIDTH - pos - SPIN_BLOCK));
    return `  ${muted(label)}  ${bar}  ${muted(formatElapsed(elapsedMs))}`;
  }
}

const NOOP_SPINNER: SpinnerHandle = { succeed() {}, fail() {}, stop() {} };
const NOOP: ProgressReporter = {
  phase() {}, transfer() {}, finish() {},
  spinner: () => NOOP_SPINNER,
};

/** A reporter that draws on a TTY and stays silent otherwise. */
export function createProgressReporter(): ProgressReporter {
  return process.stdout.isTTY ? new TerminalProgress() : NOOP;
}

/**
 * Run an indeterminate async operation behind the standard bouncing-block
 * spinner: animate `label` while it's in flight, then settle. On success the
 * line becomes a ✓ (`done`, or `label` if omitted) — or, when `done` is null,
 * the spinner just clears silently (use this when the command prints its own
 * result, e.g. a chat reply). On throw it becomes a ✗ and re-throws so the
 * caller's own error handling still runs. On a non-TTY this is a silent
 * pass-through. The single wrapper every command uses for a server call whose
 * size/duration we can't measure (deploy, generate, chat, sandbox, …).
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { done?: string | null; reporter?: ProgressReporter } = {},
): Promise<T> {
  const sp = (opts.reporter ?? createProgressReporter()).spinner(label);
  try {
    const result = await fn();
    if (opts.done === null) sp.stop(); else sp.succeed(opts.done);
    return result;
  } catch (e) {
    sp.fail();
    throw e;
  }
}

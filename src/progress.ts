// ── Gipity CLI Progress Reporter ────────────────────────────────────────
// One central place for long-running terminal feedback, so commands don't
// each reinvent status lines. Two channels:
//
//   phase(msg)              - a discrete step with no measurable size
//                             (scanning, hashing). Prints one committed line.
//   transfer(label, n, tot) - a determinate byte transfer. Renders a single
//                             in-place bar that updates as bytes move.
//
// On a non-TTY (piped output, hook-driven sync, headless -p) the reporter is a
// silent no-op - no `\r` spam in logs. Colors come from ./colors so the bar
// matches the rest of the CLI (orange fill + percentage).

import { brand, brandBold, muted, dim } from './colors.js';
import { formatSize } from './utils.js';

export interface ProgressReporter {
  /** A discrete step with no measurable progress. Commits one line. */
  phase(message: string): void;
  /** Determinate byte transfer. Cheap to call frequently - renders are throttled. */
  transfer(label: string, doneBytes: number, totalBytes: number): void;
  /** Settle the live line (commit a trailing newline if a bar is open). */
  finish(): void;
}

const CLEAR_TO_EOL = '\x1b[K';
const BAR_WIDTH = 18;
const RENDER_THROTTLE_MS = 60;

class TerminalProgress implements ProgressReporter {
  /** True while an in-place transfer line is on screen and not yet committed. */
  private liveOpen = false;
  private lastRenderAt = 0;

  phase(message: string): void {
    this.commitLive();
    process.stdout.write(`  ${muted(message)}\n`);
  }

  transfer(label: string, doneBytes: number, totalBytes: number): void {
    const finished = totalBytes > 0 && doneBytes >= totalBytes;
    // Throttle mid-flight redraws; always paint the first and final frames.
    const now = Date.now();
    if (this.liveOpen && !finished && now - this.lastRenderAt < RENDER_THROTTLE_MS) return;
    this.lastRenderAt = now;
    this.liveOpen = true;
    process.stdout.write('\r' + this.frame(label, doneBytes, totalBytes) + CLEAR_TO_EOL);
    if (finished) this.commitLive();
  }

  finish(): void {
    this.commitLive();
  }

  private commitLive(): void {
    if (!this.liveOpen) return;
    process.stdout.write('\n');
    this.liveOpen = false;
  }

  private frame(label: string, done: number, total: number): string {
    const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = brand('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
    const sizes = muted(`${formatSize(done)} / ${formatSize(total)}`);
    return `  ${muted(label)}  ${bar}  ${brandBold(`${pct}%`)}  ${sizes}`;
  }
}

const NOOP: ProgressReporter = { phase() {}, transfer() {}, finish() {} };

/** A reporter that draws on a TTY and stays silent otherwise. */
export function createProgressReporter(): ProgressReporter {
  return process.stdout.isTTY ? new TerminalProgress() : NOOP;
}

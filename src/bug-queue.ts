/**
 * Local queue for `gipity bug report` submissions that couldn't be delivered
 * immediately (no network, session expired, server hiccup). The report is
 * the one artifact that must survive the platform being the thing that's
 * broken - a bug report failing to file because the session that just broke
 * is also required to file it would silently lose the report. Queued entries
 * are flushed opportunistically wherever there's a good "we're reconnected"
 * signal: the next successful login, the top of the next `bug report`
 * invocation, and `gipity status` when it finds a valid, unexpired session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { post } from './api.js';

const QUEUE_DIR = join(process.env.GIPITY_DIR || join(homedir(), '.gipity'), 'bug-queue');

export interface QueuedBugReport {
  projectGuid: string;
  category: string;
  severity: string;
  summary: string;
  detail?: string;
}

/** Persist a report that failed to submit so it survives to the next attempt. */
export function queueBugReport(report: QueuedBugReport): void {
  mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 });
  const file = join(QUEUE_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
}

/** True when a submit failure is worth queuing for later delivery: the
 *  network was unreachable, the request timed out, the session/token was
 *  rejected, or the server had a transient failure. A validation error
 *  (bad category, missing field) would fail identically on retry, so those
 *  surface immediately instead of queuing silently forever. */
export function isRetryableFailure(err: any): boolean {
  if (err?.name === 'ApiError') {
    return err.statusCode === 401 || err.statusCode === 408 || err.statusCode >= 500;
  }
  // fetch()-level network errors and the "Not authenticated" pre-check both
  // have no statusCode - both mean "can't reach/use the platform right now".
  return typeof err?.statusCode !== 'number';
}

/** Best-effort delivery of every queued report. Never throws - called
 *  opportunistically and a flush failure must not block the caller's actual
 *  command. Returns the count successfully delivered. */
export async function flushBugQueue(): Promise<number> {
  if (!existsSync(QUEUE_DIR)) return 0;
  let delivered = 0;
  for (const file of readdirSync(QUEUE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const path = join(QUEUE_DIR, file);

    let report: QueuedBugReport;
    try {
      report = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      try { unlinkSync(path); } catch { /* already gone */ }
      continue; // corrupt entry - retrying it can never succeed
    }

    try {
      await post(`/api/${report.projectGuid}/services/bug-report/submit`, {
        category: report.category,
        severity: report.severity,
        summary: report.summary,
        detail: report.detail,
      });
      unlinkSync(path);
      delivered++;
    } catch {
      // Still undeliverable - leave it queued for the next attempt. A queued
      // report was only ever retryable at queue time (isRetryableFailure gates
      // queuing); if the server later hard-rejects it permanently (e.g. the
      // project was deleted), it sticks and retries forever. Accepted given
      // bug-report volume is tiny - better than silently dropping it.
    }
  }
  return delivered;
}

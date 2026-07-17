/**
 * Duration parsing shared by the sibling `--timeout` flags.
 *
 * `sandbox run --timeout` is native SECONDS and `page eval --timeout` is native
 * MILLISECONDS — the same flag name, two units, which reliably trips an agent
 * carrying a value from one command to the other. The reconciliation is an
 * explicit unit suffix that means the SAME thing everywhere: `--timeout 90s` is
 * 90 seconds on both, `--timeout 1500ms` is 1.5s on both. A bare number keeps
 * each command's native unit (so nothing about existing invocations changes),
 * but the portable, unambiguous form now works and the help teaches it.
 */

export interface ParsedDuration {
  /** The value converted into the requested unit ('ms' or 's'). */
  value: number;
  /** True when the input carried an explicit unit suffix (ms/s/m). */
  hadSuffix: boolean;
}

const UNIT_TO_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000 };

/** Parse a duration that MAY carry a `ms`/`s`/`m` suffix, returning it in `unit`
 *  (the caller's native unit). A bare number is taken as already being in `unit`
 *  and returned unchanged with `hadSuffix:false`, so the caller's own bare-number
 *  handling (defaults, unit-mixup guards) still runs. Returns null only when the
 *  input is not a number at all — the caller then falls back to its prior parse. */
export function parseDuration(raw: string | undefined, unit: 'ms' | 's'): ParsedDuration | null {
  if (raw === undefined) return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toLowerCase();
  if (!suffix) return { value: n, hadSuffix: false };
  const ms = n * UNIT_TO_MS[suffix];
  const value = unit === 'ms' ? ms : ms / 1_000;
  return { value, hadSuffix: true };
}

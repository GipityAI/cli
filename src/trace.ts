// Opt-in output tracing for diagnosing silent-success bugs (cli#125/#126/#108):
// invocations that exit 0 but print nothing. With GIPITY_TRACE_OUTPUT=1, every
// process.stdout/stderr write is teed as a JSONL record to
// ~/.gipity/trace/<yyyy-mm-dd_hh-mm-ss>-pid<pid>.jsonl, alongside start/exit
// markers carrying pid, argv, cwd, and TTY state. Diffing a trace against the
// captured tool output shows whether the bytes were ever emitted by this
// process (pointing at the environment) or never written (pointing at the CLI).
//
// Records are written with fs.writeSync on a raw fd, not a stream: the bug
// class under investigation is process teardown eating output, so the trace
// itself must not depend on stream flushing at exit.
import { openSync, writeSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Keyed on globalThis, not module state: the shim and the CLI entry are
// separate esbuild bundles loaded into one process (shim dynamic-imports the
// entry), so a module-level flag would double-install the tee.
const TRACE_KEY = Symbol.for('gipity.traceOutput');

type TraceState = { emit: (rec: Record<string, unknown>) => void };

/** Install the stdout/stderr tee if GIPITY_TRACE_OUTPUT=1. Idempotent per
 *  process; a re-entrant call (e.g. index.ts after shim.ts) logs a marker so
 *  the trace shows the in-process import chain actually ran. Never throws -
 *  tracing must not be able to break the CLI. */
export function installOutputTrace(label: string): void {
  if (process.env.GIPITY_TRACE_OUTPUT !== '1') return;
  try {
    const g = globalThis as Record<symbol, unknown>;
    const existing = g[TRACE_KEY] as TraceState | undefined;
    if (existing) {
      existing.emit({ event: 'reenter', label });
      return;
    }
    const dir = join(process.env.GIPITY_DIR || join(homedir(), '.gipity'), 'trace');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const fd = openSync(join(dir, `${stamp}-pid${process.pid}.jsonl`), 'a');
    const emit = (rec: Record<string, unknown>): void => {
      try {
        writeSync(fd, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
      } catch { /* trace write failure must never surface */ }
    };
    g[TRACE_KEY] = { emit } satisfies TraceState;

    emit({
      event: 'start',
      label,
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv,
      cwd: process.cwd(),
      tty: { stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY },
    });

    for (const name of ['stdout', 'stderr'] as const) {
      const stream = process[name];
      const original = stream.write.bind(stream);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream.write = ((chunk: any, encoding?: any, cb?: any): boolean => {
        emit({
          stream: name,
          data: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
        });
        return original(chunk, encoding, cb);
      }) as typeof stream.write;
    }

    process.on('exit', (code) => emit({ event: 'exit', code }));
  } catch { /* tracing is best-effort only */ }
}

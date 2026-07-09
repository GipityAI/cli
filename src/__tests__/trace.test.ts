// GIPITY_TRACE_OUTPUT=1 tees every stdout/stderr write to ~/.gipity/trace/
// as JSONL (cli#125/#126/#108 silent-success diagnosis). Pins: opt-in gating,
// start/reenter/write records, and idempotent install.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('installOutputTrace is a no-op without GIPITY_TRACE_OUTPUT=1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gipity-trace-off-'));
  process.env.GIPITY_DIR = dir;
  delete process.env.GIPITY_TRACE_OUTPUT;
  const { installOutputTrace } = await import('../trace.js');
  installOutputTrace('off');
  assert.equal(existsSync(join(dir, 'trace')), false);
});

test('installOutputTrace tees stdout writes and records start/reenter/exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gipity-trace-on-'));
  process.env.GIPITY_DIR = dir;
  process.env.GIPITY_TRACE_OUTPUT = '1';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const { installOutputTrace } = await import('../trace.js');
  try {
    installOutputTrace('first');
    installOutputTrace('second'); // same process: must log a reenter, not re-wrap
    process.stdout.write('trace-test-marker\n');
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    delete process.env.GIPITY_TRACE_OUTPUT;
  }

  const files = readdirSync(join(dir, 'trace'));
  assert.equal(files.length, 1, 'one trace file per process');
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-pid\d+\.jsonl$/);

  const records = readFileSync(join(dir, 'trace', files[0]), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const start = records[0];
  assert.equal(start.event, 'start');
  assert.equal(start.label, 'first');
  assert.equal(start.pid, process.pid);
  assert.ok(Array.isArray(start.argv) && start.argv.length > 0);
  assert.ok(records.some((r) => r.event === 'reenter' && r.label === 'second'));
  assert.ok(records.some((r) => r.stream === 'stdout' && r.data === 'trace-test-marker\n'));
});

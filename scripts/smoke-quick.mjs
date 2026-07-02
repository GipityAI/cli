// Diff-scoped smoke gate for `gw done --quick`.
//
// The full `test:smoke` compiles then runs ~70 test files (~50s). This tier
// compiles incrementally (tsconfig has "incremental": true) and then runs only
// the smoke tests it can confidently tie to the branch's changed files — but
// FALLS BACK TO THE FULL SMOKE SET whenever it can't localize a change (a broad,
// widely-imported module, or a source file with no matching test). So it is never
// LESS thorough than a safe subset: unsure ⇒ run everything. The full `/done`
// (plain `test:smoke`) stays the default gate; this only runs under `--quick`.
//
// Inputs from gw (both optional; git fallback keeps it runnable by hand):
//   GW_CHANGED_FILES  newline-separated paths changed vs the base
//   GW_BASE           base ref (default origin/main)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

// The canonical smoke set, parsed from package.json's test:smoke so the two never
// drift. Each entry is a bare stem, e.g. "cli-cmd-deploy" for that .test file.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const SMOKE = [...pkg.scripts['test:smoke'].matchAll(/dist\/__tests__\/([^\s]+)\.test\.js/g)].map((m) => m[1]);

// Always run these regardless of the diff — cheap, and they exercise the paths
// almost everything else depends on.
const CORE = ['utils', 'config', 'cli-smoke'].filter((s) => SMOKE.includes(s));

// Changed source stems whose blast radius is too wide to localize — any of these
// forces the full set. Kept deliberately conservative (safety over speed).
const BROAD = new Set(['api', 'auth', 'config', 'utils', 'index', 'sync', 'client-context', 'platform', 'upload', 'setup']);

const base = process.env.GW_BASE || 'origin/main';
const changed = (process.env.GW_CHANGED_FILES ?? '')
  .split('\n').map((s) => s.trim()).filter(Boolean);
const files = changed.length
  ? changed
  : out('git', ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);

// Compile first — tests run against dist/. Incremental keeps this ~1-2s on re-runs.
run('npx', ['tsc']);

function selectTests() {
  const src = files.filter((f) => f.startsWith('src/') && f.endsWith('.ts') && !f.includes('__tests__'));
  const changedTests = files
    .filter((f) => /^src\/__tests__\/.+\.test\.ts$/.test(f))
    .map((f) => f.replace(/^src\/__tests__\//, '').replace(/\.test\.ts$/, ''))
    .filter((s) => SMOKE.includes(s));

  // No source touched (docs/config-only, or only test files) — CORE + any changed
  // smoke tests is enough. If even that is empty, CORE alone still runs.
  if (!src.length) return [...new Set([...CORE, ...changedTests])];

  const picked = new Set([...CORE, ...changedTests]);
  for (const f of src) {
    const stem = f.split('/').pop().replace(/\.ts$/, '');
    if (BROAD.has(stem)) return null;                 // widely-imported → full set
    const hits = SMOKE.filter((t) => t.includes(stem));
    if (!hits.length) return null;                    // can't localize → full set
    hits.forEach((h) => picked.add(h));
  }
  return [...picked];
}

const selected = selectTests();
const toRun = selected ?? SMOKE;
if (!selected) console.log('smoke-quick: change not localizable — running the FULL smoke set.');
else console.log(`smoke-quick: ${toRun.length}/${SMOKE.length} smoke files for this diff — ${toRun.join(', ')}`);

run('node', ['--test', ...toRun.map((t) => `dist/__tests__/${t}.test.js`)]);

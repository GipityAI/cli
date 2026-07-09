#!/usr/bin/env node
// Bundle the hot CLI entries into single files, in place, after tsc.
//
// Why: every `gipity` invocation was paying ~100ms of ESM module resolution
// across ~200 dist files (measured via --cpu-prof; the time is Node's module
// machinery, not any one heavy module). Agents run dozens of gipity commands
// per build loop and the save-hook runs one per file save, so this fixed tax
// multiplies. A single-file bundle removes it without touching how commands
// are written or registered.
//
// The per-module tsc output stays alongside the bundles: the test suite
// (`npm run test:smoke`) imports individual dist modules, and secondary
// entries (gipcc/gipccd) still resolve their own graphs. Only the three
// entries every invocation actually executes are bundled:
//   dist/index.js         - the CLI itself
//   dist/updater/shim.js  - the `gipity` bin
//   dist/updater/check.js - the detached background updater
//
// Bundled from src (esbuild compiles TS directly) so the output overwrites
// the tsc-emitted file at the same path - all runtime-relative reads
// (package.json, build-info.json) keep working. Runtime-variable dynamic
// imports (the shim importing ~/.gipity/local/...) are left as real import()
// calls, which is exactly what we want.
import { build } from 'esbuild';
import { execFileSync } from 'child_process';

const ENTRIES = [
  ['src/index.ts', 'dist/index.js'],
  ['src/updater/shim.ts', 'dist/updater/shim.js'],
  ['src/updater/check.ts', 'dist/updater/check.js'],
];

for (const [entry, outfile] of ENTRIES) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    allowOverwrite: true,
    // tar-stream and friends are CJS with a few require()s of node builtins;
    // the esm banner gives the bundle a require() so that interop works.
    banner: {
      js: "import { createRequire as __cliCreateRequire } from 'module';\nconst require = __cliCreateRequire(import.meta.url);",
    },
    logOverride: {
      // The shim's import(pathToFileURL(...)) is variable on purpose.
      'unsupported-dynamic-import': 'silent',
    },
  });
}

// Fail the build loudly if the bundle can't even print its version - the
// smoke tests run against the unbundled tsc output, so this is the one gate
// the bundled artifact itself passes through.
const out = execFileSync(process.execPath, ['dist/index.js', '--version'], { encoding: 'utf-8' });
if (!/Gipity/.test(out)) {
  console.error('bundle smoke failed: unexpected --version output:\n' + out);
  process.exit(1);
}
console.log('✓ bundled dist/index.js, dist/updater/{shim,check}.js');

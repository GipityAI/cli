// Stamp a build marker into dist/build-info.json after every local build.
//
// Why a runtime-read JSON in dist/ rather than bumping package.json:
//   - package.json `version` is a published-release contract (npm enforces
//     one publish per number); bumping it on local builds dirties git and
//     risks publish collisions. See cli-build / cli-publish in the justfile.
//   - dist/ is gitignored, so writing here never shows up in `git status`.
//   - the npm `files` allowlist ships only dist/**/*.js, so this .json is NOT
//     part of the published tarball — released installs have no marker and
//     `gipity -v` prints a clean `v1.0.398`.
//
// Result: local `just cli-link` builds get a unique `(dev <sha>)` marker so you
// can tell whether the linked binary is your latest code, with zero git noise.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '../dist/build-info.json');

function git(args) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const sha = git('rev-parse --short HEAD') || null;
// `dirty` = uncommitted changes in the working tree at build time, so a rebuild
// of locally-edited (but not yet committed) code is still distinguishable.
const dirty = sha ? git('status --porcelain') !== '' : false;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ sha, dirty }, null, 2) + '\n');

console.log(`✓ build-info: ${sha ?? 'unknown'}${dirty ? ' (modified)' : ''}`);

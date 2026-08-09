/**
 * Which coding tools a project gets set up for.
 *
 * Two rules, and the second exists because the first isn't enough on its own:
 *   - with no explicit choice, only tools actually present here are set up
 *     (detectedTools);
 *   - an explicit `gipity init --for <tools>` is PINNED in .gipity.json, so the
 *     later `setupProjectTools()` calls in `gipity build` and the relay daemon -
 *     which pass no argument - don't quietly re-add everything (resolveProjectTools).
 *
 * Detection is exercised against a real PATH containing real executable files,
 * not a stubbed `binaryOnPath`: the whole point is that the probe agrees with
 * what a shell would find.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectedTools, resolveProjectTools, setupToolForAgent, DEFAULT_TOOLS, SUPPORTED_TOOLS } from '../setup.js';
import { clearConfigCache } from '../config.js';

const origPath = process.env.PATH;
const origCwd = process.cwd();
let work: string;
let bin: string;

/** A PATH with no coding agents on it, but still able to run `which`. */
const BARE_PATH = '/usr/bin:/bin';

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'gipity-detect-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  process.chdir(work);
  process.env.PATH = `${bin}:${BARE_PATH}`;
  clearConfigCache();
});

afterEach(() => {
  process.chdir(origCwd);
  process.env.PATH = origPath;
  clearConfigCache();
  rmSync(work, { recursive: true, force: true });
});

/** Drop a real executable on the fake PATH so `which` finds it. */
function installFakeBinary(name: string): void {
  const p = join(bin, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

/** Write a project config with an optional pinned tool list. */
function writeConfig(tools?: string[]): void {
  writeFileSync(join(work, '.gipity.json'), JSON.stringify({
    projectGuid: 'p_detect', projectSlug: 'detect', accountSlug: 'acct',
    agentGuid: 'agt_detect', conversationGuid: null,
    apiBase: 'http://localhost:7201', ignore: [],
    ...(tools ? { tools } : {}),
  }));
  clearConfigCache();
}

test('only the installed tools are set up', () => {
  installFakeBinary('opencode');
  const keys = detectedTools().map(t => t.key);
  assert.deepEqual(keys, ['opencode']);
  // The point of the change: a user with one agent does not get the others'
  // primers dropped into their project.
  assert.ok(!keys.includes('claude'));
  assert.ok(!keys.includes('gemini'));
});

test('several installed tools are all detected', () => {
  installFakeBinary('claude');
  installFakeBinary('codex');
  const keys = detectedTools().map(t => t.key);
  assert.deepEqual(keys.sort(), ['claude', 'codex']);
});

test('a machine with no coding agent falls back to the full set', () => {
  // Offering everything beats offering nothing on a fresh box or in CI -
  // the same fallback `gipity build`'s agent picker makes.
  process.env.PATH = BARE_PATH;
  assert.deepEqual(detectedTools().map(t => t.key), DEFAULT_TOOLS.map(t => t.key));
});

test('an opt-in tool is never auto-detected, even when installed', () => {
  // aider's setup writes .aider.conf.yml, which changes how aider behaves in
  // this directory - a heavier footprint than an inert primer, so it stays
  // explicit no matter what is on PATH.
  installFakeBinary('aider');
  installFakeBinary('opencode');
  assert.ok(!detectedTools().some(t => t.key === 'aider'));
});

test('a primer this project already has keeps being maintained, with no CLI', () => {
  // Copilot and Cursor are used daily by people with no CLI on PATH, and
  // primers are regenerated per release - dropping one from the refresh
  // freezes it at whatever version wrote it, so the agent reads stale Gipity
  // instructions. Also how projects set up before detection keep working.
  installFakeBinary('opencode');
  mkdirSync(join(work, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(work, '.cursor', 'rules', 'gipity.mdc'), 'old primer');
  const keys = detectedTools().map(t => t.key);
  assert.ok(keys.includes('cursor'), 'existing cursor primer was dropped');
  assert.ok(keys.includes('opencode'));
});

test('a bare .github directory does NOT enable Copilot', () => {
  // The tempting marker, and a trap: workflows and issue templates mean most
  // GitHub repos have .github, so keying on the directory would re-enable
  // Copilot almost everywhere and undo the point of detecting at all. Only its
  // actual primer counts.
  installFakeBinary('opencode');
  mkdirSync(join(work, '.github'));
  assert.ok(!detectedTools().some(t => t.key === 'copilot'));
});

test('an existing Copilot primer does enable it', () => {
  installFakeBinary('opencode');
  mkdirSync(join(work, '.github'));
  writeFileSync(join(work, '.github', 'copilot-instructions.md'), 'old primer');
  assert.ok(detectedTools().some(t => t.key === 'copilot'));
});

test('a pinned project keeps its choice - the bug this fixes', () => {
  // `gipity init --for opencode` used to hold only until the next command:
  // build.ts and the relay daemon call setupProjectTools() with no argument,
  // which fell through to every tool. Pinning is what makes --for durable.
  installFakeBinary('claude');
  installFakeBinary('codex');
  writeConfig(['opencode']);
  assert.deepEqual(resolveProjectTools().map(t => t.key), ['opencode']);
});

test('an unpinned project tracks what is installed', () => {
  installFakeBinary('claude');
  writeConfig();
  assert.deepEqual(resolveProjectTools().map(t => t.key), ['claude']);
});

test('a pin naming only unknown tools falls back to detection, not to nothing', () => {
  // A hand-edited or stale config (a tool key we no longer ship) must not
  // leave the project with zero primers - that would look like setup silently
  // doing nothing at all.
  installFakeBinary('claude');
  writeConfig(['a-tool-we-removed']);
  assert.deepEqual(resolveProjectTools().map(t => t.key), ['claude']);
});

test('every non-opt-in tool declares a binary to probe', () => {
  // A tool with no `binary` and no project marker can never be detected, so it
  // would silently vanish from every default setup.
  for (const t of DEFAULT_TOOLS) {
    assert.ok(t.binary, `${t.key} has no binary to detect it by`);
  }
});

test('SUPPORTED_TOOLS keys are unique', () => {
  const keys = SUPPORTED_TOOLS.map(t => t.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('launching an agent sets it up even when the project is pinned elsewhere', () => {
  // `gipity init --for claude` then `gipity build` -> pick opencode. The pin
  // means "don't litter my project", not "refuse to set up what I'm starting".
  // build.ts resolves the tool set BEFORE the agent picker runs, so without
  // this the agent launches with no primer and no capture.
  installFakeBinary('opencode');
  writeConfig(['claude']);
  assert.deepEqual(resolveProjectTools().map(t => t.key), ['claude'], 'pin still holds');

  assert.equal(setupToolForAgent('opencode'), true);
  // AGENTS.md is opencode's primer - it must exist now.
  assert.ok(existsSync(join(work, 'AGENTS.md')), 'opencode primer was not written');

  // ...and the pin is untouched: we made the agent work without rewriting a
  // choice the user typed.
  const cfg = JSON.parse(readFileSync(join(work, '.gipity.json'), 'utf-8'));
  assert.deepEqual(cfg.tools, ['claude']);
});

test('setupToolForAgent reports an unknown key instead of throwing', () => {
  assert.equal(setupToolForAgent('not-a-tool'), false);
});

test('a bare re-init does not widen a pinned project back out', () => {
  // `gipity init --for opencode` today, plain `gipity init` tomorrow. If the
  // bare run fell through to detection it would re-add every installed agent's
  // primer and the pin would mean nothing after the first command.
  installFakeBinary('claude');
  installFakeBinary('opencode');
  writeConfig(['opencode']);
  assert.deepEqual(resolveProjectTools().map(t => t.key), ['opencode']);
});

/**
 * Unit tests for the relay's daily harness auto-update: install-type
 * detection + plan selection (agents/self-update.ts) and the guarded update
 * runner (relay/agent-updates.ts, all subprocess/network seams injected).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isNpmManaged, npmLatestArgv, planForInstall } from '../agents/self-update.js';
import { runAgentUpdates, agentUpdateInProgress, type AgentUpdateResult } from '../relay/agent-updates.js';
import type { RemoteAgentAdapter, AgentUpdatePlan } from '../agents/types.js';

const PKG = '@anthropic-ai/claude-code';

/** A prefix layout mimicking `npm install -g` on Unix: bin/claude is a
 *  symlink into lib/node_modules/<pkg>/. */
function makeUnixNpmPrefix(): { bin: string } {
  const prefix = mkdtempSync(join(tmpdir(), 'gipity-selfupdate-'));
  const pkgDir = join(prefix, 'lib', 'node_modules', ...PKG.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const bin = join(prefix, 'bin', 'claude');
  symlinkSync(join(pkgDir, 'cli.js'), bin);
  return { bin };
}

describe('isNpmManaged', () => {
  it('detects a Unix npm-global symlink shim', () => {
    const { bin } = makeUnixNpmPrefix();
    assert.equal(isNpmManaged(bin, PKG), true);
  });

  it('detects a Windows-style shim next to node_modules/<pkg>', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'gipity-selfupdate-win-'));
    mkdirSync(join(prefix, 'node_modules', ...PKG.split('/')), { recursive: true });
    const bin = join(prefix, 'claude.cmd');
    writeFileSync(bin, '@echo off\n');
    assert.equal(isNpmManaged(bin, PKG), true);
  });

  it('rejects a standalone binary (native installer layout)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gipity-selfupdate-native-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\n');
    assert.equal(isNpmManaged(bin, PKG), false);
  });

  it('does not match a different package under node_modules', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'gipity-selfupdate-other-'));
    const otherDir = join(prefix, 'lib', 'node_modules', 'some-other-tool');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'cli.js'), '');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    const bin = join(prefix, 'bin', 'claude');
    symlinkSync(join(otherDir, 'cli.js'), bin);
    assert.equal(isNpmManaged(bin, PKG), false);
  });
});

describe('planForInstall', () => {
  it('npm-managed install → npm@latest argv with pkg set', () => {
    const { bin } = makeUnixNpmPrefix();
    const plan = planForInstall(bin, PKG, ['claude', 'update']);
    assert.ok(plan);
    assert.deepEqual(plan.argv, npmLatestArgv(PKG));
    assert.equal(plan.pkg, PKG);
  });

  it('non-npm install → the self-updater fallback, no pkg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gipity-selfupdate-fb-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '');
    const plan = planForInstall(bin, PKG, ['claude', 'update']);
    assert.ok(plan);
    assert.deepEqual(plan.argv, ['claude', 'update']);
    assert.equal(plan.pkg, undefined);
  });

  it('non-npm install without a self-updater → null (stays manual)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gipity-selfupdate-null-'));
    const bin = join(dir, 'codex');
    writeFileSync(bin, '');
    assert.equal(planForInstall(bin, '@openai/codex', null), null);
  });

  it('binary not installed → null', () => {
    assert.equal(planForInstall(null, PKG, ['claude', 'update']), null);
  });
});

// ─── runAgentUpdates (all seams injected - never spawns/fetches) ────────

function fakeAdapter(plan: AgentUpdatePlan | null | undefined): RemoteAgentAdapter {
  return {
    source: 'claude_code',
    binary: 'claude',
    ...(plan !== undefined ? { updatePlan: () => plan } : {}),
  } as unknown as RemoteAgentAdapter;
}

const noopLog = () => {};

function versionSequence(...versions: Array<string | undefined>) {
  let i = 0;
  return async () => versions[Math.min(i++, versions.length - 1)];
}

describe('runAgentUpdates', () => {
  it('updates a stale npm install and reports from → to', async () => {
    const execCalls: string[][] = [];
    const results = await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter({ argv: npmLatestArgv(PKG), label: 'npm', pkg: PKG })],
      probeVersion: versionSequence('2.1.197', '2.1.222'),
      fetchLatest: async () => '2.1.222',
      exec: async (argv) => { execCalls.push(argv); return { ok: true, output: '' }; },
    });
    assert.deepEqual(results, [{ source: 'claude_code', status: 'updated', from: '2.1.197', to: '2.1.222' }] satisfies AgentUpdateResult[]);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0], npmLatestArgv(PKG));
  });

  it('skips the spawn entirely when the registry says current', async () => {
    let execCalled = false;
    const results = await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter({ argv: npmLatestArgv(PKG), label: 'npm', pkg: PKG })],
      probeVersion: versionSequence('2.1.222'),
      fetchLatest: async () => '2.1.222',
      exec: async () => { execCalled = true; return { ok: true, output: '' }; },
    });
    assert.equal(results[0].status, 'current');
    assert.equal(execCalled, false);
  });

  it('defers (skip, no spawn) when the registry check fails', async () => {
    let execCalled = false;
    const results = await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter({ argv: npmLatestArgv(PKG), label: 'npm', pkg: PKG })],
      probeVersion: versionSequence('2.1.197'),
      fetchLatest: async () => null,
      exec: async () => { execCalled = true; return { ok: true, output: '' }; },
    });
    assert.equal(results[0].status, 'skipped');
    assert.equal(execCalled, false);
  });

  it('defers when a dispatch is in flight', async () => {
    let execCalled = false;
    const results = await runAgentUpdates({ log: noopLog, busy: () => true }, {
      adapters: [fakeAdapter({ argv: npmLatestArgv(PKG), label: 'npm', pkg: PKG })],
      probeVersion: versionSequence('2.1.197'),
      fetchLatest: async () => '2.1.222',
      exec: async () => { execCalled = true; return { ok: true, output: '' }; },
    });
    assert.equal(results[0].status, 'skipped');
    assert.match(results[0].detail ?? '', /dispatch in flight/);
    assert.equal(execCalled, false);
  });

  it('reports failure with output tail and leaves status probeable', async () => {
    const results = await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter({ argv: npmLatestArgv(PKG), label: 'npm', pkg: PKG })],
      probeVersion: versionSequence('2.1.197', '2.1.197'),
      fetchLatest: async () => '2.1.222',
      exec: async () => ({ ok: false, output: 'npm ERR! EACCES permission denied' }),
    });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].detail ?? '', /EACCES/);
  });

  it('skips adapters without an update plan', async () => {
    const results = await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter(null), fakeAdapter(undefined)],
      exec: async () => { throw new Error('must not spawn'); },
    });
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.status === 'skipped'));
  });

  it('a self-updater plan (no pkg) runs without a registry check and reports current on no-op', async () => {
    let fetchCalled = false;
    const execCalls: string[][] = [];
    const results = await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter({ argv: ['claude', 'update'], label: 'claude update' })],
      probeVersion: versionSequence('2.1.222', '2.1.222'),
      fetchLatest: async () => { fetchCalled = true; return null; },
      exec: async (argv) => { execCalls.push(argv); return { ok: true, output: 'already up to date' }; },
    });
    assert.equal(fetchCalled, false);
    assert.deepEqual(execCalls, [['claude', 'update']]);
    assert.equal(results[0].status, 'current');
  });

  it('clears the in-progress flag even when an exec seam throws', async () => {
    await runAgentUpdates({ log: noopLog }, {
      adapters: [fakeAdapter({ argv: ['claude', 'update'], label: 'claude update' })],
      probeVersion: versionSequence('1.0.0'),
      exec: async () => { throw new Error('boom'); },
    }).catch(() => { /* the throw propagates - that's fine */ });
    assert.equal(agentUpdateInProgress(), false);
  });
});

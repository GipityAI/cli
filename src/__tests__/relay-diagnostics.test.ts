/**
 * Unit tests for the relay diagnostics snapshot + consent gating. No daemon,
 * no network - `collectDiagnostics()` (best-effort host/version probe) and the
 * `state` consent helpers against a throwaway $GIPITY_DIR.
 *
 * GIPITY_DIR is set BEFORE importing `state` (it captures the dir at module
 * load), so the imports are dynamic and run after the assignment below.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.GIPITY_DIR = mkdtempSync(join(tmpdir(), 'gipity-diag-'));
delete process.env.GIPITY_NO_DIAGNOSTICS;
delete process.env.DO_NOT_TRACK;

const state = await import('../relay/state.js');
const { collectDiagnostics, parseVersion } = await import('../relay/diagnostics.js');

describe('parseVersion', () => {
  it('extracts the semver token from noisy --version output', () => {
    assert.equal(parseVersion('2.0.14 (Claude Code)'), '2.0.14');
    assert.equal(parseVersion('codex-cli 1.2.3\n'), '1.2.3');
    assert.equal(parseVersion('v1.4'), '1.4');
    assert.equal(parseVersion('1.0.0-beta.2'), '1.0.0-beta.2');
  });

  it('returns undefined when there is nothing version-like', () => {
    assert.equal(parseVersion(''), undefined);
    assert.equal(parseVersion('command not found'), undefined);
  });
});

describe('collectDiagnostics', () => {
  it('returns a best-effort snapshot with real host + version fields', async () => {
    const d = await collectDiagnostics();
    assert.equal(typeof d.gipity_version, 'string');
    assert.equal(typeof d.collected_at, 'string');
    assert.equal(d.node_version, process.versions.node);
    assert.equal(d.os?.platform, process.platform);
    assert.equal(d.os?.arch, process.arch);
    assert.ok((d.cpu?.count ?? 0) > 0, 'cpu.count should be positive');
    assert.equal(typeof d.mem?.total, 'number');
  });

  it('never throws even though individual probes may fail', async () => {
    await assert.doesNotReject(() => collectDiagnostics());
  });
});

describe('diagnostics consent (state)', () => {
  it('defaults to consented when never asked', () => {
    assert.equal(state.getDiagnosticsConsent(), undefined);
    assert.equal(state.diagnosticsConsented(), true);
  });

  it('honors an explicit opt-out and opt-in', () => {
    state.setDiagnosticsConsent(false);
    assert.equal(state.getDiagnosticsConsent(), false);
    assert.equal(state.diagnosticsConsented(), false);

    state.setDiagnosticsConsent(true);
    assert.equal(state.getDiagnosticsConsent(), true);
    assert.equal(state.diagnosticsConsented(), true);
  });

  it('honors the headless GIPITY_NO_DIAGNOSTICS / DO_NOT_TRACK env opt-out', () => {
    state.setDiagnosticsConsent(true); // stored on, but env should win
    process.env.GIPITY_NO_DIAGNOSTICS = '1';
    assert.equal(state.diagnosticsConsented(), false);
    delete process.env.GIPITY_NO_DIAGNOSTICS;

    process.env.DO_NOT_TRACK = 'true';
    assert.equal(state.diagnosticsConsented(), false);
    delete process.env.DO_NOT_TRACK;

    // A falsy env value ("0"/"false") does not disable.
    process.env.GIPITY_NO_DIAGNOSTICS = '0';
    assert.equal(state.diagnosticsConsented(), true);
    delete process.env.GIPITY_NO_DIAGNOSTICS;
  });
});

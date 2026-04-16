import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { runCli } from './helpers/spawn-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8')).version;

describe('cli-smoke: --version and --help', () => {
  it('--version prints the package version', () => {
    const r = runCli(['--version']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), PKG_VERSION);
  });

  it('--help shows version banner near the top and grouped sections in order', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);

    const out = r.stdout;
    assert.match(out, new RegExp(`Gipity CLI\\s+v${PKG_VERSION.replace(/\./g, '\\.')}`));

    const sections = ['Setup:', 'Project:', 'Resources:', 'Agent:', 'Maintenance:'];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = out.indexOf(s);
      assert.ok(idx > -1, `missing section header: ${s}`);
      assert.ok(idx > lastIdx, `section out of order: ${s} appeared before previous one`);
      lastIdx = idx;
    }
  });

  it('--help lists doctor and update under Maintenance', () => {
    const r = runCli(['--help']);
    const maint = r.stdout.split('Maintenance:')[1] ?? '';
    assert.match(maint, /\bdoctor\b/);
    assert.match(maint, /\bupdate\b/);
  });
});

describe('cli-smoke: doctor', () => {
  it('runs cleanly and reports auto-updates disabled when env is set', () => {
    const r = runCli(['doctor']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /auto-updates/);
    assert.match(r.stdout, /disabled \(DISABLE_AUTOUPDATER=1\)/);
  });
});

describe('cli-smoke: error behavior', () => {
  it('unknown command exits non-zero', () => {
    const r = runCli(['definitely-not-a-real-command']);
    assert.notEqual(r.status, 0);
  });

  it('status without auth prints not-logged-in message', () => {
    const r = runCli(['status']);
    // status returns 0 even when not logged in (it's a status report)
    const combined = r.stdout + r.stderr;
    assert.match(combined, /not logged in|Not a Gipity project/i);
  });
});

describe('cli-smoke: subcommand --help wiring', () => {
  for (const cmd of ['chat', 'deploy', 'db', 'fn', 'memory', 'scaffold', 'login', 'doctor', 'update']) {
    it(`gipity ${cmd} --help exits 0`, () => {
      const r = runCli([cmd, '--help']);
      assert.equal(r.status, 0, `${cmd} --help failed: ${r.stderr}`);
    });
  }
});

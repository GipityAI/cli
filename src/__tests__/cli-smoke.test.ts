import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { runCli } from './helpers/spawn-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8')).version;

describe('cli-smoke: --version and --help', () => {
  it('--version prints the package version + auth status', () => {
    const r = runCli(['--version']);
    assert.equal(r.status, 0);
    // Branded line: "Gipity v1.2.3"
    assert.match(r.stdout, new RegExp(`Gipity\\s+v${PKG_VERSION.replace(/\./g, '\\.')}`));
    // Auth status: logged-in, session expired, or never logged in.
    assert.match(r.stdout, /Logged in as |Session expired for |Not logged in\. Run: gipity login/);
  });

  it('--help shows version banner near the top and grouped sections in order', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);

    const out = r.stdout;
    assert.match(out, new RegExp(`Gipity CLI\\s+v${PKG_VERSION.replace(/\./g, '\\.')}`));
    // Cross-agent positioning line surfaces in top-level help.
    assert.match(out, /no MCP server needed/);

    const sections = ['Common:', 'Connect:', 'Project:', 'Files:', 'App building:', 'Utilities:', 'Agent:', 'Setup:'];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = out.indexOf(s);
      assert.ok(idx > -1, `missing section header: ${s}`);
      assert.ok(idx > lastIdx, `section out of order: ${s} appeared before previous one`);
      lastIdx = idx;
    }
  });

  it('--help lists doctor and update under Setup', () => {
    const r = runCli(['--help']);
    const setup = r.stdout.split('Setup:')[1] ?? '';
    assert.match(setup, /\bdoctor\b/);
    assert.match(setup, /\bupdate\b/);
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

  it('unknown command prints the error AND top-level help inline (no second --help trip)', () => {
    const r = runCli(['browser']);
    const out = r.stdout + r.stderr;
    assert.match(out, /unknown command 'browser'/);
    assert.match(out, /Showing `gipity --help`:/);
    // The grouped catalog follows, so a guessed verb still surfaces the real one.
    assert.match(out, /Utilities:/);
    assert.match(out, /\bpage\b/);
  });

  it('excess args print the error AND that command\'s help inline', () => {
    // Mirrors an agent guessing `gipity add <tmpl> title=...` (positional k=v).
    const r = runCli(['add', '2d-game', 'title=x']);
    const out = r.stdout + r.stderr;
    assert.match(out, /too many arguments for 'add'/);
    assert.match(out, /Showing `gipity add --help`:/);
    // The help reveals the real flag the agent should have used.
    assert.match(out, /--title/);
  });

  it('excess args on a nested subcommand label the full command path', () => {
    const r = runCli(['page', 'screenshot', 'http://a', 'extra']);
    const out = r.stdout + r.stderr;
    assert.match(out, /too many arguments for 'screenshot'/);
    assert.match(out, /Showing `gipity page screenshot --help`:/);
  });

  it('the one-line error is the LAST line, after the help (survives `| tail`)', () => {
    // Agents pipe CLI output through `| tail` to bound context; a leading error
    // would be dropped, leaving only help that reads as success-with-no-result.
    // (`expr` became optional for --file support, so `url` is the missing arg.)
    const r = runCli(['page', 'eval']);
    const out = (r.stdout + r.stderr).replace(/\s+$/, '');
    const lastLine = out.slice(out.lastIndexOf('\n') + 1);
    assert.match(lastLine, /error: missing required argument 'url'/);
    // Help still renders inline (no second --help trip), including addHelpText.
    assert.match(out, /Usage: gipity page eval/);
    assert.match(out, /Testing realtime\/shared state/);
  });

  it('eval with a url but neither <expr> nor --file errors on the last line', () => {
    const r = runCli(['page', 'eval', 'http://a']);
    const out = (r.stdout + r.stderr).replace(/\s+$/, '');
    const lastLine = out.slice(out.lastIndexOf('\n') + 1);
    assert.match(lastLine, /Provide an inline <expr> arg or --file <path>/);
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

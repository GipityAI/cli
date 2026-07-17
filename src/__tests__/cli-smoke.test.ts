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

    const sections = ['Start here:', 'App build & ship:', 'App backend:', 'App services:', 'Files:', 'Gip (cloud agent):', 'Utilities:', 'Connect & setup:'];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = out.indexOf(s);
      assert.ok(idx > -1, `missing section header: ${s}`);
      assert.ok(idx > lastIdx, `section out of order: ${s} appeared before previous one`);
      lastIdx = idx;
    }
  });

  it('--help lists doctor and update under Connect & setup', () => {
    const r = runCli(['--help']);
    const setup = r.stdout.split('Connect & setup:')[1] ?? '';
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

  // Agents bound context by piping through `| head -N` or `| tail -N`. The 90-odd
  // lines of root help sit between the two copies of the error, so a single copy
  // at either end alone would be truncated away by one of them - leaving output
  // that reads as success-with-no-result. Both ends must carry the failure.
  // Regression: cli#131, where `gipity whoami --json 2>&1 | head -20` showed only
  // the help banner and the agent never learned it had guessed a bad command.
  it('usage errors survive truncation from either end (head AND tail)', () => {
    for (const argv of [['browser'], ['db', 'query'], ['fn', 'call', '--bogus']]) {
      const out = (runCli(argv).stdout + runCli(argv).stderr).split('\n');
      const head = out.slice(0, 3).join('\n');
      const tail = out.slice(-3).join('\n');
      assert.match(head, /^error: /m, `head of \`gipity ${argv.join(' ')}\` carries no error`);
      assert.match(tail, /^error: /m, `tail of \`gipity ${argv.join(' ')}\` carries no error`);
    }
  });

  // Runs with a scratch HOME, so there is no signed-in user: `auth` is null.
  // What matters is that `whoami` reaches `status` at all instead of dying as an
  // unknown command - it's the name agents reach for to find their identity.
  it('`whoami` is an alias for `status`, not an unknown command', () => {
    const r = runCli(['whoami', '--json']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok('auth' in out && 'project' in out, 'whoami --json should print the status payload');
  });

  it('excess args print the error AND that command\'s help inline', () => {
    // Mirrors an agent guessing `gipity add <tmpl> title=...` (positional k=v).
    const r = runCli(['add', '2d-game', 'title=x']);
    const out = r.stdout + r.stderr;
    // The error names the offending token and maps the k=v form to the flag.
    assert.match(out, /unexpected extra argument 'title=x' for 'add'/);
    assert.match(out, /did you mean `--title`/);
    assert.match(out, /Showing `gipity add --help`:/);
    // The help reveals the real flag the agent should have used.
    assert.match(out, /--title/);
  });

  it('excess args on a nested subcommand label the full command path', () => {
    const r = runCli(['page', 'screenshot', 'http://a', 'extra']);
    const out = r.stdout + r.stderr;
    assert.match(out, /unexpected extra argument 'extra' for 'screenshot'/);
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
    // Usage + options render inline (no second --help trip) so the agent can
    // self-correct, but the verbose examples/realtime narrative (addHelpText)
    // does NOT: dumping ~70 lines of off-topic guidance on a one-line arg error
    // buries the error and its trailing realtime block has misled agents.
    assert.match(out, /Usage: gipity page eval/);
    assert.doesNotMatch(out, /Testing realtime\/shared state/);
  });

  it('eval with a url but neither <expr> nor --file renders help inline, error last', () => {
    // Action-level arg-shape errors (expr is optional so commander can't catch
    // this one) must follow the same convention as commander-detected errors:
    // help inline, one-line error LAST so it survives `| tail`.
    const r = runCli(['page', 'eval', 'http://a']);
    const out = (r.stdout + r.stderr).replace(/\s+$/, '');
    const lastLine = out.slice(out.lastIndexOf('\n') + 1);
    assert.match(lastLine, /error: Provide an inline <expr> arg or --file <path>/);
    assert.match(out, /Usage: gipity page eval/);
    // Same as above: no verbose examples/realtime narrative on the error path.
    assert.doesNotMatch(out, /Testing realtime\/shared state/);
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
  for (const cmd of ['chat', 'deploy', 'db', 'fn', 'memory', 'add', 'login', 'doctor', 'update']) {
    it(`gipity ${cmd} --help exits 0`, () => {
      const r = runCli([cmd, '--help']);
      assert.equal(r.status, 0, `${cmd} --help failed: ${r.stderr}`);
    });
  }

  it('page eval --help DOES show the full examples/realtime narrative', () => {
    // The narrative is withheld only on the error path; an explicit --help is
    // where the examples, time-budget, and realtime guidance belong in full.
    const r = runCli(['page', 'eval', '--help']);
    assert.equal(r.status, 0);
    const out = r.stdout + r.stderr;
    assert.match(out, /Testing realtime\/shared state/);
    assert.match(out, /Examples:/);
  });
});

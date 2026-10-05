import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { normalizeAliases } from '../flag-aliases.js';

/** Minimal program mirroring the real flag collision: `logs` aliases --from to
 * --since, while `workflow create` declares --from for real. */
function buildProgram(): Command {
  const program = new Command();
  program.command('logs').option('--since <when>', 'start time');
  const wf = program.command('workflow');
  wf.command('create').requiredOption('--from <path>', 'yaml path');
  const fn = program.command('fn');
  fn.command('call <name> [body]').option('--data <json>', 'request body');
  program.command('gmail').command('send').requiredOption('--body <text>', 'email body');
  program.command('add <name>').option('--title <title>', 'app title').option('--force', 'overwrite').option('-o, --output <path>', 'out');
  program.command('sandbox').command('run <cmd...>').option('--title <t>', 't');
  return program;
}

describe('normalizeAliases', () => {
  it('rewrites --out to --output', () => {
    assert.deepEqual(
      normalizeAliases(['node', 'gipity', 'generate', 'image', 'prompt', '--out', 'rice.jpg']),
      ['node', 'gipity', 'generate', 'image', 'prompt', '--output', 'rice.jpg'],
    );
  });

  it('leaves canonical --output unchanged', () => {
    assert.deepEqual(
      normalizeAliases(['--output', 'rice.jpg']),
      ['--output', 'rice.jpg'],
    );
  });

  it('rewrites the retired --no-sync-output to --discard-output (cli#134)', () => {
    assert.deepEqual(
      normalizeAliases(['node', 'gipity', 'sandbox', 'run', 'bash', 'cmd', '--no-sync-output', 'docs/preview*']),
      ['node', 'gipity', 'sandbox', 'run', 'bash', 'cmd', '--discard-output', 'docs/preview*'],
    );
  });

  it('rewrites --out=value equals form', () => {
    assert.deepEqual(
      normalizeAliases(['--out=rice.jpg']),
      ['--output=rice.jpg'],
    );
  });

  it('rewrites --db to --database', () => {
    assert.deepEqual(
      normalizeAliases(['db', 'query', 'select 1', '--db', 'mydb']),
      ['db', 'query', 'select 1', '--database', 'mydb'],
    );
  });

  it('rewrites multiple aliases in one argv', () => {
    assert.deepEqual(
      normalizeAliases(['--proj', 'foo', '--aspect', '16:9', '--out', 'x.png']),
      ['--project', 'foo', '--aspect-ratio', '16:9', '--output', 'x.png'],
    );
  });

  it('leaves unrelated long flags alone', () => {
    assert.deepEqual(
      normalizeAliases(['--quality', 'high', '--unknown-flag', 'v']),
      ['--quality', 'high', '--unknown-flag', 'v'],
    );
  });

  it('does not rewrite short flags', () => {
    assert.deepEqual(normalizeAliases(['-o', 'x.png']), ['-o', 'x.png']);
  });

  it('does not rewrite positional values', () => {
    assert.deepEqual(
      normalizeAliases(['fn', 'call', 'foo', '{"x":"--out"}']),
      ['fn', 'call', 'foo', '{"x":"--out"}'],
    );
  });

  it('does not rewrite a flag whose prefix matches an alias', () => {
    assert.deepEqual(
      normalizeAliases(['--output-dir']),
      ['--output-dir'],
    );
  });

  describe('command-scoped suppression', () => {
    it('leaves --from alone for a command that declares it for real', () => {
      const program = buildProgram();
      assert.deepEqual(
        normalizeAliases(['node', 'gipity', 'workflow', 'create', '--from', 'workflows/x.yaml'], program),
        ['node', 'gipity', 'workflow', 'create', '--from', 'workflows/x.yaml'],
      );
    });

    it('still aliases --from to --since for a command that does not', () => {
      const program = buildProgram();
      assert.deepEqual(
        normalizeAliases(['node', 'gipity', 'logs', '--from', '1h'], program),
        ['node', 'gipity', 'logs', '--since', '1h'],
      );
    });

    it('aliases the HTTP-convention --body to --data on fn call', () => {
      const program = buildProgram();
      assert.deepEqual(
        normalizeAliases(['node', 'gipity', 'fn', 'call', 'smart-tracks', '--body', '{"x":1}'], program),
        ['node', 'gipity', 'fn', 'call', 'smart-tracks', '--data', '{"x":1}'],
      );
    });

    it('leaves --body alone for gmail send, which declares it for real', () => {
      const program = buildProgram();
      assert.deepEqual(
        normalizeAliases(['node', 'gipity', 'gmail', 'send', '--body', 'hello'], program),
        ['node', 'gipity', 'gmail', 'send', '--body', 'hello'],
      );
    });
  });

  describe('key=value positional read as the option it names (cli#199)', () => {
    const p = buildProgram();
    const run = (...args: string[]) => normalizeAliases(['node', 'gipity', ...args], p).slice(2);

    it('rewrites an excess title=... into --title=...', () => {
      assert.deepEqual(run('add', '2d-game', 'title=Gip Brick Breaker'), ['add', '2d-game', '--title=Gip Brick Breaker']);
    });

    it('counts option values so a flag before the operand does not shift positions', () => {
      assert.deepEqual(run('add', '--output', 'x', '2d-game', 'title=T'), ['add', '--output', 'x', '2d-game', '--title=T']);
    });

    it('maps an aliased key (out=) through FLAG_ALIASES', () => {
      assert.deepEqual(run('add', '2d-game', 'out=dir'), ['add', '2d-game', '--output=dir']);
    });

    it('leaves a k=v that fills a declared positional alone', () => {
      assert.deepEqual(run('add', 'title=x'), ['add', 'title=x']);
    });

    it('leaves boolean flags, unknown keys, variadic commands and post-`--` tokens alone', () => {
      assert.deepEqual(run('add', '2d-game', 'force=true'), ['add', '2d-game', 'force=true']);
      assert.deepEqual(run('add', '2d-game', 'colour=red'), ['add', '2d-game', 'colour=red']);
      assert.deepEqual(run('sandbox', 'run', 'echo', 'title=x'), ['sandbox', 'run', 'echo', 'title=x']);
      assert.deepEqual(run('add', '2d-game', '--', 'title=x'), ['add', '2d-game', '--', 'title=x']);
    });
  });
});

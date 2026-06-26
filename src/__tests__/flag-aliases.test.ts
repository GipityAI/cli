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
  program.command('email').command('send').requiredOption('--body <body>', 'email body');
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

    it('leaves --body alone for email send, which declares it for real', () => {
      const program = buildProgram();
      assert.deepEqual(
        normalizeAliases(['node', 'gipity', 'email', 'send', '--body', 'hello'], program),
        ['node', 'gipity', 'email', 'send', '--body', 'hello'],
      );
    });
  });
});

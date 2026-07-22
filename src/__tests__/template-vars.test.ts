/**
 * Tests for the template-var substitution that `gipity init` runs before
 * syncing local files up. The bug it guards against: karaoke-captions shipped
 * literal `{{PROJECT_GUID}}` to production because init didn't substitute,
 * every fn-call 404'd, and no error reached the Dashboard because the
 * analytics script wasn't loaded either.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTemplateVars,
  substituteString,
  substituteDir,
  KNOWN_PLACEHOLDERS,
} from '../template-vars.js';

describe('buildTemplateVars', () => {
  it('produces a value for every KNOWN_PLACEHOLDERS key', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_abc12345', projectName: 'My App' });
    for (const key of KNOWN_PLACEHOLDERS) {
      assert.ok(key in vars, `missing substitution for ${key}`);
    }
  });

  it('html-escapes the title', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_x', projectName: '<script>alert(1)</script>' });
    assert.equal(vars['{{TITLE}}'], '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('embeds projectGuid in the analytics script data-app attribute', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_kmunc98x', projectName: 'X' });
    assert.match(vars['{{ANALYTICS_SCRIPT}}'], /data-app="p_kmunc98x"/);
  });

  it('omits meta tags when no description is provided', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_x', projectName: 'X' });
    assert.equal(vars['{{DESCRIPTION_META}}'], '');
    assert.equal(vars['{{OG_DESCRIPTION}}'], '');
  });

  it('{{HEAD_BLOCK}} carries the twitter/og card set and icon links', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_x', projectName: 'Gorillas' });
    const head = vars['{{HEAD_BLOCK}}'];
    assert.match(head, /<title>Gorillas<\/title>/);
    assert.match(head, /twitter:card" content="summary_large_image"/);
    assert.match(head, /og:title" content="Gorillas"/);
    assert.match(head, /apple-touch-icon/);
    assert.match(head, /rel="manifest"/);
    assert.match(head, /theme-color" content="#[0-9a-f]{6}"/);
    // No slugs → no canonical/og:url/og:image (they need an absolute URL).
    assert.doesNotMatch(head, /canonical|og:url|og:image/);
  });

  it('{{HEAD_BLOCK}} gains canonical + absolute og:image when slugs are known', () => {
    const vars = buildTemplateVars({
      projectGuid: 'p_x', projectName: 'Gorillas', description: 'Bananas at 60fps',
      accountSlug: 'steve', projectSlug: 'gorillas',
    });
    const head = vars['{{HEAD_BLOCK}}'];
    assert.match(head, /rel="canonical" href="https:\/\/app\.gipity\.ai\/steve\/gorillas\/"/);
    assert.match(head, /og:image" content="https:\/\/app\.gipity\.ai\/steve\/gorillas\/images\/og-image\.png"/);
    assert.match(head, /twitter:image"/);
    assert.match(head, /meta name="description" content="Bananas at 60fps"/);
  });

  it('{{HEAD_BLOCK}} theme-color is deterministic per project guid', () => {
    const a = buildTemplateVars({ projectGuid: 'p_abc12345', projectName: 'A' })['{{HEAD_BLOCK}}'];
    const b = buildTemplateVars({ projectGuid: 'p_abc12345', projectName: 'B' })['{{HEAD_BLOCK}}'];
    const color = (h: string): string => /theme-color" content="(#[0-9a-f]{6})"/.exec(h)![1];
    assert.equal(color(a), color(b));
  });
});

describe('substituteString', () => {
  it('replaces all known placeholders', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_abc', projectName: 'Acme' });
    const out = substituteString(
      `const APP_GUID = '{{PROJECT_GUID}}';\n<title>{{TITLE}}</title>`,
      vars,
    );
    assert.match(out, /APP_GUID = 'p_abc'/);
    assert.match(out, /<title>Acme<\/title>/);
    assert.doesNotMatch(out, /\{\{PROJECT_GUID\}\}/);
    assert.doesNotMatch(out, /\{\{TITLE\}\}/);
  });

  it('leaves unrelated content alone', () => {
    const vars = buildTemplateVars({ projectGuid: 'p_x', projectName: 'X' });
    const input = `const x = "{{NOT_A_TEMPLATE_VAR}}"; // user content`;
    assert.equal(substituteString(input, vars), input);
  });
});

describe('substituteDir', () => {
  function makeTmpProject(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'gipity-tmpl-test-'));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('rewrites every file that contains a known placeholder', async () => {
    const { dir, cleanup } = makeTmpProject();
    try {
      mkdirSync(join(dir, 'src', 'js'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'index.html'),
        `<title>{{TITLE}}</title>\n{{ANALYTICS_SCRIPT}}`,
      );
      writeFileSync(
        join(dir, 'src', 'js', 'main.js'),
        `const APP_GUID = '{{PROJECT_GUID}}';`,
      );
      writeFileSync(join(dir, 'src', 'image.png'), Buffer.from([0x89, 0x50]));

      const result = await substituteDir(dir, { projectGuid: 'p_xyz98765', projectName: 'Caption Test 05' });

      assert.equal(result.changed.length, 2, `changed: ${JSON.stringify(result.changed)}`);
      assert.equal(result.unresolved.length, 0);

      const html = readFileSync(join(dir, 'src', 'index.html'), 'utf-8');
      assert.match(html, /<title>Caption Test 05<\/title>/);
      assert.match(html, /data-app="p_xyz98765"/);

      const js = readFileSync(join(dir, 'src', 'js', 'main.js'), 'utf-8');
      assert.equal(js, `const APP_GUID = 'p_xyz98765';`);
    } finally {
      cleanup();
    }
  });

  it('flags placeholders we don\'t know about as unresolved', async () => {
    const { dir, cleanup } = makeTmpProject();
    try {
      writeFileSync(join(dir, 'README.md'), `Hello {{FUTURE_THING}} world.`);
      const result = await substituteDir(dir, { projectGuid: 'p_x', projectName: 'X' });
      assert.equal(result.changed.length, 0);
      assert.equal(result.unresolved.length, 1);
      assert.deepEqual(result.unresolved[0].tokens, ['{{FUTURE_THING}}']);
    } finally {
      cleanup();
    }
  });

  it('does not touch files without any placeholder', async () => {
    const { dir, cleanup } = makeTmpProject();
    try {
      writeFileSync(join(dir, 'plain.js'), `const x = 1;`);
      const result = await substituteDir(dir, { projectGuid: 'p_x', projectName: 'X' });
      assert.equal(result.changed.length, 0);
      assert.equal(result.unresolved.length, 0);
      assert.equal(readFileSync(join(dir, 'plain.js'), 'utf-8'), `const x = 1;`);
    } finally {
      cleanup();
    }
  });

  it('post-condition: no known placeholders remain in any rewritten file', async () => {
    // This is the regression guard for the karaoke shipped-`{{PROJECT_GUID}}` bug.
    const { dir, cleanup } = makeTmpProject();
    try {
      for (const key of KNOWN_PLACEHOLDERS) {
        writeFileSync(join(dir, `${key.replace(/[{}]/g, '')}.html`), key);
      }
      await substituteDir(dir, { projectGuid: 'p_real', projectName: 'Real' });
      for (const key of KNOWN_PLACEHOLDERS) {
        const content = readFileSync(join(dir, `${key.replace(/[{}]/g, '')}.html`), 'utf-8');
        assert.doesNotMatch(content, new RegExp(key.replace(/[{}]/g, '\\$&')),
          `placeholder ${key} leaked into deployed content`);
      }
    } finally {
      cleanup();
    }
  });
});

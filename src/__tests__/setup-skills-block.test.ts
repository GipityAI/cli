/**
 * applySkillsBlock - the managed CLAUDE.md / AGENTS.md integration block.
 *
 * The Gipity block is delimited by stable markers and fully managed: every
 * run refreshes it to the current SKILLS_CONTENT while preserving the user's
 * own content outside the markers. These cover the four input shapes plus
 * idempotency - the property that makes per-session refresh safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySkillsBlock, GIPITY_BLOCK_BEGIN, GIPITY_BLOCK_END, SKILLS_CONTENT } from '../setup.js';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('no file: returns the managed block, marker-wrapped and newline-terminated', () => {
  const out = applySkillsBlock(null);
  assert.ok(out.includes(GIPITY_BLOCK_BEGIN), 'has begin marker');
  assert.ok(out.includes(GIPITY_BLOCK_END), 'has end marker');
  assert.ok(out.includes(SKILLS_CONTENT), 'has current skills content');
  assert.ok(out.endsWith('\n'), 'ends with a newline');
});

test('marked block: content refreshed in place, surrounding text preserved', () => {
  const stale = `${GIPITY_BLOCK_BEGIN}\n# Gipity Integration\n\nSTALE OLD TEXT\n${GIPITY_BLOCK_END}`;
  const file = `# My Project\n\nMy own notes.\n\n${stale}\n\nNotes below the block.\n`;
  const out = applySkillsBlock(file);
  assert.ok(out.includes('My own notes.'), 'preserves content above the block');
  assert.ok(out.includes('Notes below the block.'), 'preserves content below the block');
  assert.ok(!out.includes('STALE OLD TEXT'), 'stale block content is replaced');
  assert.ok(out.includes(SKILLS_CONTENT), 'has current skills content');
  assert.equal(count(out, GIPITY_BLOCK_BEGIN), 1, 'exactly one block, no duplication');
});

test('legacy unmarked block: migrated to a marked block, stale text dropped', () => {
  const file = '# Gipity Integration\n\nOLD UNMARKED CONTENT from a previous CLI version.\n';
  const out = applySkillsBlock(file);
  assert.ok(out.includes(GIPITY_BLOCK_BEGIN), 'now wrapped in markers');
  assert.ok(!out.includes('OLD UNMARKED CONTENT'), 'legacy text dropped');
  assert.ok(out.includes(SKILLS_CONTENT), 'has current skills content');
  assert.equal(count(out, GIPITY_BLOCK_BEGIN), 1, 'exactly one block');
});

test('legacy unmarked block below user content: user content survives migration', () => {
  const file = '# My Project\n\nImportant project notes.\n\n# Gipity Integration\n\nstale legacy text\n';
  const out = applySkillsBlock(file);
  assert.ok(out.includes('Important project notes.'), 'user content above is kept');
  assert.ok(!out.includes('stale legacy text'), 'legacy block is replaced');
  assert.equal(count(out, GIPITY_BLOCK_BEGIN), 1, 'exactly one block');
});

test('user file with no Gipity block: block appended, user content kept', () => {
  const file = '# My Project\n\nJust my notes, no Gipity block.\n';
  const out = applySkillsBlock(file);
  assert.ok(out.startsWith('# My Project'), 'user content stays at the top');
  assert.ok(out.includes('Just my notes, no Gipity block.'), 'user content kept');
  assert.ok(out.includes(GIPITY_BLOCK_BEGIN), 'managed block appended');
});

test('idempotent: re-applying the result changes nothing', () => {
  const inputs: (string | null)[] = [
    null,
    '# My Project\n\nNotes.\n',
    '# Gipity Integration\n\nlegacy text\n',
  ];
  for (const input of inputs) {
    const once = applySkillsBlock(input);
    assert.equal(applySkillsBlock(once), once, 'a second apply is a no-op');
  }
});

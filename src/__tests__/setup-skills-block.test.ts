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
import { applySkillsBlock, applyAiderConf, GIPITY_BLOCK_BEGIN, GIPITY_BLOCK_END, SKILLS_CONTENT, PRIMER_FILES, AIDER_CONF_FILE, DEFAULT_SYNC_IGNORE, SUPPORTED_TOOLS, DEFAULT_TOOLS } from '../setup.js';
import { shouldIgnore } from '../config.js';

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

// ── Primer files must never leak into project sync ──────────────────────
// Regression guard: GEMINI.md / copilot / cursor primers were added to the
// tool registry but not to DEFAULT_SYNC_IGNORE, so `gipity sync` uploaded them
// as project content. PRIMER_FILES is now the single source both read from.

test('every primer file is excluded by the sync filter', () => {
  for (const file of Object.values(PRIMER_FILES)) {
    assert.ok(
      shouldIgnore(file, DEFAULT_SYNC_IGNORE),
      `primer ${file} should be sync-ignored but is not`,
    );
  }
});

test('every supported tool maps to a known primer file', () => {
  // A new tool added to the registry without a PRIMER_FILES entry would
  // reintroduce the leak; this fails loudly if the two ever drift.
  const known = new Set<string>(Object.keys(PRIMER_FILES));
  for (const tool of SUPPORTED_TOOLS) {
    assert.ok(known.has(tool.key), `tool "${tool.key}" has no PRIMER_FILES entry`);
  }
});

test('the aider conf file is excluded by the sync filter', () => {
  assert.ok(shouldIgnore(AIDER_CONF_FILE, DEFAULT_SYNC_IGNORE));
});

test('the default tool set excludes opt-in tools', () => {
  assert.ok(SUPPORTED_TOOLS.some(t => t.key === 'aider'), 'aider is a supported tool');
  assert.ok(!DEFAULT_TOOLS.some(t => t.optIn), 'no opt-in tool in the default set');
  assert.ok(DEFAULT_TOOLS.some(t => t.key === 'claude'), 'default set keeps the standard tools');
});

// ── applyAiderConf - the .aider.conf.yml read: merge ────────────────────
// Aider auto-discovers no instruction file, so its setup must wire a
// `read: AGENTS.md` entry into .aider.conf.yml without clobbering whatever
// config the user already has. Covers the three `read:` shapes aider
// documents (flow list, scalar, block list) plus absence and idempotency.

test('aider conf: no file -> fresh conf reading AGENTS.md', () => {
  const out = applyAiderConf(null);
  assert.ok(out, 'writes a new file');
  assert.match(out!, /^read: \[AGENTS\.md\]$/m, 'has a read: entry');
  assert.ok(out!.startsWith('#'), 'leads with an explanatory comment');
  assert.ok(out!.endsWith('\n'), 'newline-terminated');
});

test('aider conf: existing conf without read: -> entry appended, rest kept', () => {
  const out = applyAiderConf('model: gpt-5\nauto-commits: false\n');
  assert.ok(out!.includes('model: gpt-5'), 'user keys preserved');
  assert.match(out!, /^read: \[AGENTS\.md\]$/m);
});

test('aider conf: flow-list read: -> AGENTS.md joins the list', () => {
  const out = applyAiderConf('read: [CONVENTIONS.md, notes.txt]\n');
  assert.match(out!, /^read: \[CONVENTIONS\.md, notes\.txt, AGENTS\.md\]$/m);
});

test('aider conf: empty flow-list read: -> AGENTS.md fills it', () => {
  const out = applyAiderConf('read: []\n');
  assert.match(out!, /^read: \[AGENTS\.md\]$/m);
});

test('aider conf: scalar read: -> promoted to a list with both entries', () => {
  const out = applyAiderConf('read: CONVENTIONS.md\n');
  assert.match(out!, /^read: \[CONVENTIONS\.md, AGENTS\.md\]$/m);
});

test('aider conf: block-list read: -> AGENTS.md added as an item, indent matched', () => {
  const out = applyAiderConf('read:\n  - CONVENTIONS.md\nmodel: gpt-5\n');
  const lines = out!.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['read:', '  - AGENTS.md', '  - CONVENTIONS.md']);
  assert.ok(out!.includes('model: gpt-5'), 'later keys preserved');
});

test('aider conf: AGENTS.md already wired -> no change', () => {
  for (const conf of [
    'read: [AGENTS.md]\n',
    'read: AGENTS.md\n',
    'read:\n  - AGENTS.md\n',
    'read: [CONVENTIONS.md, AGENTS.md]\n',
  ]) {
    assert.equal(applyAiderConf(conf), null, `should be a no-op for: ${JSON.stringify(conf)}`);
  }
});

test('aider conf: a commented-out entry does not count as wired', () => {
  const out = applyAiderConf('# read: [AGENTS.md]\nmodel: gpt-5\n');
  assert.ok(out, 'still adds a live entry');
  assert.match(out!, /^read: \[AGENTS\.md\]$/m);
  assert.ok(out!.includes('# read: [AGENTS.md]'), 'the comment is preserved');
});

test('aider conf: idempotent - re-applying the result is a no-op', () => {
  const inputs: (string | null)[] = [
    null,
    'model: gpt-5\n',
    'read: [CONVENTIONS.md]\n',
    'read: CONVENTIONS.md\n',
    'read:\n  - CONVENTIONS.md\n',
  ];
  for (const input of inputs) {
    const once = applyAiderConf(input);
    assert.ok(once, 'first apply changes the file');
    assert.equal(applyAiderConf(once), null, 'second apply is a no-op');
  }
});

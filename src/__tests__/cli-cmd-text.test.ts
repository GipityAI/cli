import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runCli } from './helpers/spawn-cli.js';
import {
  analyzeText,
  countOccurrences,
  findPositions,
  nthWord,
  nthChar,
  areAnagrams,
} from '../helpers/text-analysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Mirror drift guard ──────────────────────────────────────────────────
// cli/src/helpers/text-analysis.ts is a hand copy of the canonical
// platform/packages/shared/src/text-analysis.ts (the CLI ships standalone and
// can't import @easyclaw/shared). Gip's text_analyze tool uses the shared copy;
// the CLI uses this mirror. If they drift, the two surfaces compute DIFFERENTLY.
// This asserts the logic body (everything from the first export onward, i.e.
// excluding the intentionally-different header comment) is byte-identical.
test('CLI text-analysis mirror matches the shared canonical source', () => {
  // __dirname = cli/dist/__tests__ at runtime; sources are under the repo tree.
  const mirrorPath = resolve(__dirname, '../../src/helpers/text-analysis.ts');
  const canonicalPath = resolve(
    __dirname,
    '../../../platform/packages/shared/src/text-analysis.ts',
  );
  const ANCHOR = 'export interface LetterCount';
  const bodyFrom = (path: string) => {
    const src = readFileSync(path, 'utf-8');
    const i = src.indexOf(ANCHOR);
    assert.notEqual(i, -1, `anchor "${ANCHOR}" not found in ${path}`);
    return src.slice(i).trimEnd();
  };
  assert.equal(
    bodyFrom(mirrorPath),
    bodyFrom(canonicalPath),
    'CLI mirror has drifted from @easyclaw/shared text-analysis - re-sync the two files (shared is the source of truth).',
  );
});

// ── Pure-logic unit tests (the part that must be correct) ───────────────

test('analyzeText: the strawberry case', () => {
  const a = analyzeText('strawberry');
  assert.equal(a.characters, 10);
  assert.equal(a.letters, 10);
  assert.equal(a.words, 1);
  const r = a.letterFrequency.find((f) => f.letter === 'r');
  assert.equal(r?.count, 3, 'strawberry has three r\'s');
  assert.equal(a.reversed, 'yrrebwarts');
});

test('analyzeText: counts categories and structure', () => {
  const a = analyzeText('Hello, world! 123\n\nSecond paragraph here.');
  assert.equal(a.digits, 3);
  assert.ok(a.punctuation >= 3); // comma, bang, period
  assert.equal(a.paragraphs, 2);
  assert.equal(a.sentences, 2);
  assert.equal(a.words, 6);
});

test('analyzeText: empty string is well-defined', () => {
  const a = analyzeText('');
  assert.equal(a.characters, 0);
  assert.equal(a.words, 0);
  assert.equal(a.lines, 0);
  assert.equal(a.isPalindrome, false);
  assert.equal(a.letterFrequency.length, 0);
});

test('analyzeText: palindrome ignores case/space/punct', () => {
  assert.equal(analyzeText('A man, a plan, a canal: Panama').isPalindrome, true);
  assert.equal(analyzeText('hello').isPalindrome, false);
});

test('analyzeText: counts code points, not UTF-16 units', () => {
  const a = analyzeText('a😀b');
  assert.equal(a.characters, 3);
  assert.equal(a.reversed, 'b😀a');
});

test('countOccurrences: overlapping vs non-overlapping', () => {
  assert.deepEqual(countOccurrences('banana', 'an'), {
    needle: 'an',
    caseSensitive: false,
    wholeWord: false,
    overlapping: 2,
    nonOverlapping: 2,
  });
  const aaa = countOccurrences('aaa', 'aa');
  assert.equal(aaa.overlapping, 2);
  assert.equal(aaa.nonOverlapping, 1);
});

test('countOccurrences: case sensitivity', () => {
  assert.equal(countOccurrences('The the THE', 'the', false).nonOverlapping, 3);
  assert.equal(countOccurrences('The the THE', 'the', true).nonOverlapping, 1);
  assert.equal(countOccurrences('abc', '').overlapping, 0);
});

test('nthWord / nthChar are 1-indexed, bounded, and negative-aware', () => {
  assert.equal(nthWord('the quick brown fox', 3), 'brown');
  assert.equal(nthWord('one two', 5), null);
  assert.equal(nthWord('the quick brown fox', -1), 'fox'); // last
  assert.equal(nthChar('hello', 1), 'h');
  assert.equal(nthChar('hello', 5), 'o');
  assert.equal(nthChar('hello', -1), 'o'); // last
  assert.equal(nthChar('hello', 6), null);
});

test('countOccurrences: whole-word vs substring', () => {
  assert.equal(countOccurrences('the theory of the', 'the').nonOverlapping, 3); // includes "theory"
  assert.equal(countOccurrences('the theory of the', 'the', false, true).nonOverlapping, 2); // whole-word only
});

test('findPositions: 1-indexed, overlapping', () => {
  assert.deepEqual(findPositions('mississippi', 'ss'), [3, 6]);
  assert.deepEqual(findPositions('aaa', 'aa'), [1, 2]);
  assert.deepEqual(findPositions('abc', 'z'), []);
});

test('areAnagrams: ignores case/space/punct', () => {
  assert.equal(areAnagrams('listen', 'silent').isAnagram, true);
  assert.equal(areAnagrams('Dormitory', 'Dirty Room!').isAnagram, true);
  assert.equal(areAnagrams('hello', 'world').isAnagram, false);
});

test('analyzeText: longest/shortest/avg use punctuation-trimmed words', () => {
  const a = analyzeText('how many s in this sentence?');
  assert.equal(a.longestWord, 'sentence', 'trailing "?" is not part of the word');
  assert.equal(a.shortestWord, 's');
  assert.equal(a.averageWordLength, 3.7); // 22 letters / 6 words

  const b = analyzeText('a well-known — "quote"');
  assert.equal(b.words, 4); // wc -w semantics: the bare dash is still a token
  assert.equal(b.longestWord, 'well-known', 'internal hyphen kept');
  assert.equal(b.shortestWord, 'a', 'pure-punctuation token is not a word');
  assert.equal(b.averageWordLength, 5.3); // (1 + 10 + 5) / 3

  const c = analyzeText("Don't stop");
  assert.equal(c.longestWord, "Don't", 'internal apostrophe and case kept');
});

test('analyzeText: vowel/consonant/case + word frequency', () => {
  const a = analyzeText('The cat sat. The cat ran.');
  assert.equal(a.uppercase, 2); // two T's
  assert.equal(a.vowels, 6); // e,a,a,e,a,a
  const the = a.wordFrequency.find((w) => w.word === 'the');
  assert.equal(the?.count, 2);
  const cat = a.wordFrequency.find((w) => w.word === 'cat');
  assert.equal(cat?.count, 2);
});

// ── CLI wiring (spawns the built binary; local, no server) ──────────────

test('gipity text analyze <text> prints a profile', () => {
  const r = runCli(['text', 'analyze', 'strawberry']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /r:3/);
  assert.match(r.stdout, /Reversed/);
  assert.match(r.stdout, /yrrebwarts/);
});

test('gipity text analyze --json emits parseable JSON', () => {
  const r = runCli(['text', 'analyze', 'hello world', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.words, 2);
  assert.equal(data.characters, 11);
});

test('gipity text analyze --count reports both overlap modes', () => {
  const r = runCli(['text', 'analyze', 'banana', '--count', 'an']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 non-overlapping/);
  assert.match(r.stdout, /2 overlapping/);
});

test('gipity text analyze --word returns the Nth word', () => {
  const r = runCli(['text', 'analyze', 'the quick brown fox', '--word', '3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /brown/);
});

test('gipity text analyze --anagram checks anagrams', () => {
  const r = runCli(['text', 'analyze', 'listen', '--anagram', 'silent']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /yes/);
});

test('gipity text analyze --find lists positions', () => {
  const r = runCli(['text', 'analyze', 'mississippi', '--find', 'ss']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3, 6/);
});

test('gipity text analyze --word -1 returns the last word', () => {
  const r = runCli(['text', 'analyze', 'one two three', '--word', '-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /three/);
});

test('gipity text analyze reads stdin', () => {
  const r = runCli(['text', 'analyze'], { env: {} });
  // No stdin piped in the test harness → no text → usage error, exit 1.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No text/);
});

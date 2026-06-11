/**
 * text-analysis.ts - Pure, deterministic text analysis.
 *
 * MIRRORED from platform/packages/shared/src/text-analysis.ts. The CLI ships
 * standalone (it does not depend on @easyclaw/shared), so this is a hand copy
 * of the canonical logic - same pattern as the TEMPLATES/KITS catalog mirror
 * in add.ts / prompts.ts. The drift guard in cli-cmd-text.test.ts asserts the
 * body below stays byte-identical to the shared source (the source of truth).
 *
 * Everything operates on Unicode code points (via `[...text]`) so multi-byte
 * characters count as one, and the category counts always sum to the total.
 */

export interface LetterCount {
  letter: string;
  count: number;
}

export interface WordCount {
  word: string;
  count: number;
}

/** How many top entries the word-frequency list keeps. */
export const WORD_FREQUENCY_TOP = 10;

export interface TextAnalysis {
  /** Total characters including all whitespace. */
  characters: number;
  /** Characters excluding literal space (U+0020) characters. */
  charactersNoSpaces: number;
  /** Characters excluding all whitespace (spaces, tabs, newlines, …). */
  charactersNoWhitespace: number;
  letters: number;
  /** Uppercase letters (Unicode). */
  uppercase: number;
  /** Lowercase letters (Unicode). */
  lowercase: number;
  /** Vowels among a–z (aeiou, case-insensitive). */
  vowels: number;
  /** Consonants among a–z (case-insensitive). */
  consonants: number;
  digits: number;
  /** Punctuation + symbols. */
  punctuation: number;
  /** All whitespace (spaces, tabs, newlines, …). */
  whitespace: number;
  /** Literal space (U+0020) characters only. */
  spaces: number;
  /** Characters in none of the above buckets. */
  other: number;
  /** Whitespace-separated tokens (matches `wc -w`). */
  words: number;
  /** Distinct words, case-insensitive, surrounding punctuation trimmed. */
  uniqueWords: number;
  /** Approximate: count of `.`/`!`/`?` terminator groups. */
  sentences: number;
  lines: number;
  /** Blocks separated by one or more blank lines. */
  paragraphs: number;
  /** Longest word, surrounding punctuation trimmed ("sentence?" → "sentence"). */
  longestWord: string;
  /** Shortest word, surrounding punctuation trimmed; pure-punctuation tokens excluded. */
  shortestWord: string;
  /** Mean word length (surrounding punctuation trimmed), one decimal. */
  averageWordLength: number;
  /** a–z frequency, case-insensitive, only letters that appear, count desc. */
  letterFrequency: LetterCount[];
  /** Most common words (top WORD_FREQUENCY_TOP), case-insensitive. */
  wordFrequency: WordCount[];
  reversed: string;
  /** True if alphanumerics read the same forwards and backwards. */
  isPalindrome: boolean;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** Split into Unicode code points (so emoji / accented chars count as one). */
function chars(text: string): string[] {
  return [...text];
}

/** Whitespace-separated tokens, empties dropped. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Strip leading/trailing punctuation/symbols from a token for word identity. */
function trimWordPunct(token: string): string {
  return token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

/** Normalize to lowercase alphanumerics only (for palindrome / anagram). */
function alnumLower(text: string): string[] {
  return chars(text)
    .filter((ch) => /[\p{L}\p{N}]/u.test(ch))
    .map((ch) => ch.toLowerCase());
}

export function analyzeText(text: string): TextAnalysis {
  const cps = chars(text);

  let letters = 0;
  let uppercase = 0;
  let lowercase = 0;
  let vowels = 0;
  let consonants = 0;
  let digits = 0;
  let punctuation = 0;
  let whitespace = 0;
  let spaces = 0;
  let other = 0;
  const freq = new Map<string, number>();

  for (const ch of cps) {
    if (/\s/u.test(ch)) {
      whitespace++;
      if (ch === ' ') spaces++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
      if (/\p{Lu}/u.test(ch)) uppercase++;
      else if (/\p{Ll}/u.test(ch)) lowercase++;
      if (/[a-z]/i.test(ch)) {
        const lower = ch.toLowerCase();
        freq.set(lower, (freq.get(lower) ?? 0) + 1);
        if (VOWELS.has(lower)) vowels++;
        else consonants++;
      }
    } else if (/\p{Nd}/u.test(ch)) {
      digits++;
    } else if (/[\p{P}\p{S}]/u.test(ch)) {
      punctuation++;
    } else {
      other++;
    }
  }

  const tokens = tokenize(text);
  // Word identity for the per-word stats: surrounding punctuation trimmed
  // ("sentence?" → "sentence"), internal hyphens/apostrophes kept, and
  // pure-punctuation tokens dropped. `words` itself stays the wc -w token count.
  const wordsTrimmed = tokens.map((t) => trimWordPunct(t)).filter(Boolean);
  const lengths = wordsTrimmed.map((t) => chars(t).length);
  const cleaned = wordsTrimmed.map((t) => t.toLowerCase());
  const uniq = new Set(cleaned);

  const wordFreqMap = new Map<string, number>();
  for (const w of cleaned) wordFreqMap.set(w, (wordFreqMap.get(w) ?? 0) + 1);
  const wordFrequency: WordCount[] = [...wordFreqMap.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, WORD_FREQUENCY_TOP);

  const sentences = (text.match(/[.!?]+(?=\s|$)/gu) ?? []).length;
  const lines = text === '' ? 0 : text.split('\n').length;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;

  const longestWord = wordsTrimmed.reduce(
    (a, b) => (chars(b).length > chars(a).length ? b : a),
    '',
  );
  const shortestWord = wordsTrimmed.length
    ? wordsTrimmed.reduce((a, b) => (chars(b).length < chars(a).length ? b : a))
    : '';
  const averageWordLength = lengths.length
    ? Math.round((lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10) / 10
    : 0;

  const letterFrequency: LetterCount[] = [...freq.entries()]
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter));

  const reversed = cps.slice().reverse().join('');

  const normalized = alnumLower(text);
  const isPalindrome =
    normalized.length > 0 &&
    normalized.join('') === normalized.slice().reverse().join('');

  return {
    characters: cps.length,
    charactersNoSpaces: cps.length - spaces,
    charactersNoWhitespace: cps.length - whitespace,
    letters,
    uppercase,
    lowercase,
    vowels,
    consonants,
    digits,
    punctuation,
    whitespace,
    spaces,
    other,
    words: tokens.length,
    uniqueWords: uniq.size,
    sentences,
    lines,
    paragraphs,
    longestWord,
    shortestWord,
    averageWordLength,
    letterFrequency,
    wordFrequency,
    reversed,
    isPalindrome,
  };
}

export interface OccurrenceCount {
  needle: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Matches that may share characters ("aa" in "aaa" → 2). */
  overlapping: number;
  /** Matches consuming the string left-to-right ("aa" in "aaa" → 1). */
  nonOverlapping: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count occurrences of a substring.
 * - Default: both overlapping and non-overlapping counts (they differ for
 *   self-overlapping needles like "aa").
 * - wholeWord: count only whole-word matches (\b boundaries); overlapping and
 *   non-overlapping are equal in that mode.
 */
export function countOccurrences(
  text: string,
  needle: string,
  caseSensitive = false,
  wholeWord = false,
): OccurrenceCount {
  if (needle === '') {
    return { needle, caseSensitive, wholeWord, overlapping: 0, nonOverlapping: 0 };
  }

  if (wholeWord) {
    const flags = caseSensitive ? 'gu' : 'giu';
    const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, flags);
    const n = (text.match(re) ?? []).length;
    return { needle, caseSensitive, wholeWord, overlapping: n, nonOverlapping: n };
  }

  const hay = caseSensitive ? text : text.toLowerCase();
  const sub = caseSensitive ? needle : needle.toLowerCase();

  let overlapping = 0;
  for (let i = hay.indexOf(sub); i !== -1; i = hay.indexOf(sub, i + 1)) overlapping++;
  let nonOverlapping = 0;
  for (let i = hay.indexOf(sub); i !== -1; i = hay.indexOf(sub, i + sub.length)) nonOverlapping++;

  return { needle, caseSensitive, wholeWord, overlapping, nonOverlapping };
}

/** 1-indexed code-point positions where a substring starts (overlapping). */
export function findPositions(
  text: string,
  needle: string,
  caseSensitive = false,
): number[] {
  if (needle === '') return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const sub = caseSensitive ? needle : needle.toLowerCase();
  const positions: number[] = [];
  for (let i = hay.indexOf(sub); i !== -1; i = hay.indexOf(sub, i + 1)) {
    // Convert UTF-16 index to 1-indexed code-point position.
    positions.push([...hay.slice(0, i)].length + 1);
  }
  return positions;
}

/** Resolve a 1-indexed position, supporting negatives (-1 = last). */
function resolveIndex(n: number, len: number): number | null {
  const idx = n < 0 ? len + n + 1 : n;
  return idx >= 1 && idx <= len ? idx : null;
}

/** Nth word (whitespace-separated), 1-indexed; negative counts from the end. */
export function nthWord(text: string, n: number): string | null {
  const tokens = tokenize(text);
  const idx = resolveIndex(n, tokens.length);
  return idx === null ? null : tokens[idx - 1];
}

/** Nth character (code point), 1-indexed; negative counts from the end. */
export function nthChar(text: string, n: number): string | null {
  const cps = chars(text);
  const idx = resolveIndex(n, cps.length);
  return idx === null ? null : cps[idx - 1];
}

export interface AnagramResult {
  isAnagram: boolean;
  /** Sorted normalized letters of each input (what was actually compared). */
  normalizedA: string;
  normalizedB: string;
}

/** Are two strings anagrams? Ignores case, spaces, and punctuation. */
export function areAnagrams(a: string, b: string): AnagramResult {
  const na = alnumLower(a).sort().join('');
  const nb = alnumLower(b).sort().join('');
  return { isAnagram: na.length > 0 && na === nb, normalizedA: na, normalizedB: nb };
}

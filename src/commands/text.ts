import { Command } from 'commander';
import { readFileSync } from 'fs';
import { run } from '../helpers/command.js';
import { error as clrError, bold, dim, brand } from '../colors.js';
import {
  analyzeText,
  countOccurrences,
  findPositions,
  nthWord,
  nthChar,
  areAnagrams,
} from '../helpers/text-analysis.js';

/** Read text from --file, a positional arg, or stdin (in that precedence). */
function resolveInput(args: string[], opts: { file?: string }): string {
  if (opts.file) return readFileSync(opts.file, 'utf-8');
  if (args.length) return args.join(' ');
  // No arg → read stdin (supports `echo … | gipity text analyze`).
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function formatProfile(a: ReturnType<typeof analyzeText>): string {
  const L: string[] = [];
  const row = (label: string, val: string | number) =>
    L.push(`  ${label.padEnd(22)}${val}`);

  L.push(bold('Counts'));
  row('Characters', a.characters);
  row('Chars (no spaces)', a.charactersNoSpaces);
  row('Chars (no whitespace)', a.charactersNoWhitespace);
  row('Letters', a.letters);
  row('  Uppercase', a.uppercase);
  row('  Lowercase', a.lowercase);
  row('  Vowels (a-z)', a.vowels);
  row('  Consonants (a-z)', a.consonants);
  row('Digits', a.digits);
  row('Punctuation/symbols', a.punctuation);
  row('Whitespace', a.whitespace);
  row('Spaces', a.spaces);
  if (a.other) row('Other', a.other);
  L.push('');
  L.push(bold('Words & structure'));
  row('Words', a.words);
  row('Unique words', a.uniqueWords);
  row('Sentences', a.sentences);
  row('Lines', a.lines);
  row('Paragraphs', a.paragraphs);
  if (a.words) {
    row('Longest word', `${a.longestWord} (${[...a.longestWord].length})`);
    row('Shortest word', `${a.shortestWord} (${[...a.shortestWord].length})`);
    row('Avg word length', a.averageWordLength);
  }
  L.push('');
  L.push(bold('Letter frequency') + dim('  (a–z, case-insensitive)'));
  if (a.letterFrequency.length) {
    const freq = a.letterFrequency
      .map((f) => `${f.letter}:${f.count}`)
      .join('  ');
    L.push(`  ${freq}`);
  } else {
    L.push(dim('  (no letters)'));
  }
  if (a.wordFrequency.length) {
    L.push('');
    L.push(bold('Top words'));
    L.push('  ' + a.wordFrequency.map((w) => `${w.word}:${w.count}`).join('  '));
  }
  L.push('');
  L.push(bold('Other'));
  row('Reversed', a.reversed);
  row('Palindrome', a.isPalindrome ? 'yes' : 'no');
  return L.join('\n');
}

const analyzeCommand = new Command('analyze')
  .description('Deterministic character/word analysis of text (local, no network)')
  .argument('[text...]', 'Text to analyze (or pipe via stdin, or use --file)')
  .option('--file <path>', 'Read text from a file')
  .option('--count <substring>', 'Count occurrences of a substring')
  .option('--find <substring>', 'List 1-indexed positions of a substring')
  .option('--word <n>', 'Return the Nth word (negative counts from the end)', (v) => parseInt(v, 10))
  .option('--char <n>', 'Return the Nth character (negative counts from the end)', (v) => parseInt(v, 10))
  .option('--anagram <other>', 'Check whether the text is an anagram of <other>')
  .option('--whole-word', 'Match whole words only (for --count)')
  .option('--case-sensitive', 'Make --count / --find case-sensitive')
  .option('--json', 'Output as JSON')
  .action((args: string[], opts) =>
    run('Text analyze', async () => {
      const text = resolveInput(args, opts);
      if (text === '' && !opts.file) {
        console.error(
          clrError('No text. Pass it as an argument, pipe via stdin, or use --file.'),
        );
        process.exit(1);
      }

      // Targeted queries short-circuit the full profile.
      if (opts.count !== undefined) {
        const r = countOccurrences(text, opts.count, !!opts.caseSensitive, !!opts.wholeWord);
        if (opts.json) return void console.log(JSON.stringify(r));
        const mode = [
          r.caseSensitive ? 'case-sensitive' : 'case-insensitive',
          r.wholeWord ? 'whole-word' : null,
        ].filter(Boolean).join(', ');
        const counts = r.wholeWord
          ? `${r.nonOverlapping}`
          : `${r.nonOverlapping} non-overlapping, ${r.overlapping} overlapping`;
        console.log(`  "${r.needle}" (${mode}): ${counts}`);
        return;
      }
      if (opts.find !== undefined) {
        const positions = findPositions(text, opts.find, !!opts.caseSensitive);
        if (opts.json) return void console.log(JSON.stringify({ needle: opts.find, positions }));
        console.log(
          positions.length
            ? `  "${opts.find}" at: ${positions.join(', ')}`
            : dim(`  "${opts.find}" not found`),
        );
        return;
      }
      if (opts.anagram !== undefined) {
        const r = areAnagrams(text, opts.anagram);
        if (opts.json) return void console.log(JSON.stringify(r));
        console.log(`  ${r.isAnagram ? 'yes' : 'no'} - anagram of "${opts.anagram}"`);
        return;
      }
      if (opts.word !== undefined) {
        const w = nthWord(text, opts.word);
        if (opts.json) return void console.log(JSON.stringify({ word: w, n: opts.word }));
        console.log(w === null ? dim('  (out of range)') : `  ${w}`);
        return;
      }
      if (opts.char !== undefined) {
        const c = nthChar(text, opts.char);
        if (opts.json) return void console.log(JSON.stringify({ char: c, n: opts.char }));
        console.log(c === null ? dim('  (out of range)') : `  ${c}`);
        return;
      }

      const analysis = analyzeText(text);
      if (opts.json) return void console.log(JSON.stringify(analysis));
      console.log(formatProfile(analysis));
    }),
  );

// Parent namespace. One capability today (analyze); namespaced for a lean
// top-level surface and room for future text operations.
export const textCommand = new Command('text')
  .description(`Deterministic text analysis - char/word counts, frequency, occurrences (${brand('text analyze')})`)
  .addCommand(analyzeCommand);

textCommand.action(() => {
  textCommand.help();
});

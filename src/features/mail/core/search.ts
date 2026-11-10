/**
 * How search reads what the member typed: as words, each a run of letters and digits, so nothing
 * typed is syntax. The index matches each word as the start of a word in what it holds, ignoring
 * case and accents the way its tokenizer folds them, and the list marks the same words in each row.
 */

/** A run of letters and digits, which is a word to search and to the index alike. */
const WORD = /[\p{L}\p{N}]+/gu;

/** Every word of a search, as typed. None when nothing typed is a letter or a digit. */
export function searchWords(text: string): string[] {
  return text.normalize('NFKC').match(WORD) ?? [];
}

/** The words a search marks, folded once for every row it marks. */
export type Marks = readonly string[];

/** One stretch of text, marked by a search or not. */
export type Run = { text: string; isMarked: boolean };

/** The words of a search, ready to mark text with. */
export function marksOf(search: string): Marks {
  return searchWords(search).map(foldForSearch);
}

/**
 * Text split into the stretches a search marks and those between them. A word is marked as far as
 * the longest word typed that it begins with, so a search for "lun ada" marks "Lun" in "Lunch" and
 * "Ada" in "Ada Park". A row the index found marks every word typed in what it holds.
 */
export function highlight(text: string, marks: Marks): Run[] {
  if (marks.length === 0) return [{ text, isMarked: false }];
  const runs: Run[] = [];
  let from = 0;
  for (const word of text.matchAll(WORD)) {
    const length = markedLength(word[0], marks);
    if (length === 0) continue;
    if (word.index > from) runs.push({ text: text.slice(from, word.index), isMarked: false });
    runs.push({ text: text.slice(word.index, word.index + length), isMarked: true });
    from = word.index + length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), isMarked: false });
  return runs;
}

/** How much of a word, as written, the longest mark it begins with covers. Nothing, without one. */
function markedLength(word: string, marks: Marks): number {
  let longest = 0;
  for (const mark of marks) {
    let folded = '';
    let length = 0;
    for (const char of word) {
      if (folded.length >= mark.length) break;
      folded += foldChar(char);
      length += char.length;
    }
    if (folded.startsWith(mark)) longest = Math.max(longest, length);
  }
  return longest;
}

/**
 * Text as the index compares it, folded as FTS5's `unicode61 remove_diacritics 2` tokenizer folds:
 * lowercase, and a Latin letter on an ASCII base without its accents. Nothing else is spelled out,
 * so a ligature, a fullwidth letter or a Cyrillic й stays itself.
 */
export function foldForSearch(text: string): string {
  let folded = '';
  for (const char of text) folded += foldChar(char);
  return folded;
}

function foldChar(char: string): string {
  const special = FTS5_FOLDS[char];
  if (special !== undefined) return special;
  const decomposed = char.normalize('NFD');
  const base = decomposed[0] ?? '';
  return decomposed.length > 1 && /[A-Za-z]/.test(base) ? base.toLowerCase() : char.toLowerCase();
}

/**
 * Where FTS5's folding, from Unicode 6.1's tables, differs from lowercasing and stripping accents.
 * `foldForSearch`'s test reads every one of them back from the index.
 */
const FTS5_FOLDS: Partial<Record<string, string>> = {
  // Case folding beyond lowercase.
  µ: 'μ',
  ſ: 's',
  ẛ: 's',
  ς: 'σ',
  ϐ: 'β',
  ϑ: 'θ',
  ϕ: 'φ',
  ϖ: 'π',
  ϰ: 'κ',
  ϱ: 'ρ',
  ϵ: 'ε',
  '\u1fbe': 'ι',
  // An accent its table keeps.
  Ǡ: 'ǡ',
  ǡ: 'ǡ',
  // Newer than its tables.
  Ϳ: 'Ϳ',
};

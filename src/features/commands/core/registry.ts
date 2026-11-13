import { matches, shortcutsOf, type KeyPress, type Shortcuts } from './keys.ts';

/** What every command has, whatever draws it. */
export type CommandLike = {
  id: string;
  title: string;
  /** Where the palette and the shortcut sheet list it, such as "Conversation" or "Go to". */
  group: string;
  shortcut?: Shortcuts;
  /** Whether it can run now. A command that can't is left out of the palette and its key does nothing. */
  isEnabled?: boolean;
};

const isEnabled = (command: CommandLike) => command.isEnabled !== false;

/** The command a key press runs, if one that can run now has that shortcut. */
export function commandFor<C extends CommandLike>(
  commands: readonly C[],
  press: KeyPress,
  isApple: boolean,
): C | undefined {
  return commands.find(
    (command) =>
      isEnabled(command) &&
      command.shortcut &&
      shortcutsOf(command.shortcut).some((shortcut) => matches(shortcut, press, isApple)),
  );
}

/** Words too little to name a command, which mail is full of. */
const LITTLE_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'with',
  'you',
  'your',
]);

/**
 * The commands the palette lists for what's been typed: every command that can run when nothing
 * is, else those whose title has a word starting with each typed word, best first, where a title
 * that starts with the text comes before one that merely holds its words. Little words such as
 * "the" name no command, typed or in a title, so typing only them searches mail alone.
 */
export function matching<C extends CommandLike>(commands: readonly C[], text: string): C[] {
  const runnable = commands.filter(isEnabled);
  const typed = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (typed.length === 0) return runnable;
  const words = typed.filter((word) => !LITTLE_WORDS.has(word));
  if (words.length === 0) return [];
  const said = typed.join(' ');
  return runnable
    .filter((command) => {
      const titleWords = command.title
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((word) => !LITTLE_WORDS.has(word));
      return words.every((word) => titleWords.some((titleWord) => titleWord.startsWith(word)));
    })
    .toSorted(
      (a, b) =>
        Number(b.title.toLowerCase().startsWith(said)) -
        Number(a.title.toLowerCase().startsWith(said)),
    );
}

/**
 * What's wrong with a set of commands as one registry: an id twice, or two commands on one key,
 * since then a key could run either. Each problem as a sentence, so a test can show them all.
 */
export function problemsOf(commands: readonly CommandLike[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const { id, shortcut } of commands) {
    if (ids.has(id)) problems.push(`Two commands are called ${id}.`);
    ids.add(id);
    if (!shortcut) continue;
    for (const key of shortcutsOf(shortcut)) {
      const other = keys.get(key.toLowerCase());
      if (other) problems.push(`${key} is the key of both ${other} and ${id}.`);
      keys.set(key.toLowerCase(), id);
    }
  }
  return problems;
}

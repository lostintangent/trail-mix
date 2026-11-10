import { matches, type KeyPress, type Shortcut } from './keys.ts';

/** What every command has, whatever draws it. */
export type CommandLike = {
  id: string;
  title: string;
  /** Where the palette and the shortcut sheet list it, such as "Conversation" or "Go to". */
  group: string;
  shortcut?: Shortcut;
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
      isEnabled(command) && command.shortcut && matches(command.shortcut, press, isApple),
  );
}

/**
 * The commands the palette lists for what's been typed: every command that can run when nothing
 * is, else those whose title has a word starting with each typed word, best first, where a title
 * that starts with the text comes before one that merely holds its words.
 */
export function matching<C extends CommandLike>(commands: readonly C[], text: string): C[] {
  const runnable = commands.filter(isEnabled);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return runnable;
  const typed = words.join(' ');
  return runnable
    .filter((command) => {
      const titleWords = command.title.toLowerCase().split(/[\s,]+/);
      return words.every((word) => titleWords.some((titleWord) => titleWord.startsWith(word)));
    })
    .toSorted(
      (a, b) =>
        Number(b.title.toLowerCase().startsWith(typed)) -
        Number(a.title.toLowerCase().startsWith(typed)),
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
    const other = keys.get(shortcut.toLowerCase());
    if (other) problems.push(`${shortcut} is the key of both ${other} and ${id}.`);
    keys.set(shortcut.toLowerCase(), id);
  }
  return problems;
}

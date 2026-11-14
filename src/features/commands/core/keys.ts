/**
 * Shortcuts: one key, with the modifiers it needs, written as `E`, `#`, `Shift+U` or `Mod+K`. `Mod`
 * is ⌘ on Apple platforms and Ctrl elsewhere. A key that's a character on its own, such as `#` or
 * `?`, matches whatever modifiers made it, since keyboards differ in which Shift gives it.
 */
type Shortcut = string;
export type Shortcuts = Shortcut | readonly [Shortcut, ...Shortcut[]];

/** The keys that run a command, whether it has one key or aliases. */
export const shortcutsOf = (shortcuts: Shortcuts): readonly Shortcut[] =>
  typeof shortcuts === 'string' ? [shortcuts] : shortcuts;

/** The key cap shown in the palette and shortcut sheet. */
export const primaryShortcut = (shortcuts: Shortcuts): Shortcut =>
  typeof shortcuts === 'string' ? shortcuts : shortcuts[0];

/** Every key that runs a command, for its tooltip. */
export const labelShortcuts = (shortcuts: Shortcuts, isApple: boolean): string =>
  shortcutsOf(shortcuts)
    .map((shortcut) => label(shortcut, isApple))
    .join(', ');

/** What a shortcut needs of a key event. */
export type KeyPress = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

type Parsed = { key: string; mod: boolean; shift: boolean; alt: boolean };

function parse(shortcut: Shortcut): Parsed {
  const parts = shortcut.split('+');
  const key = parts.at(-1) ?? '';
  const modifiers = new Set(parts.slice(0, -1));
  return {
    key,
    mod: modifiers.has('Mod'),
    shift: modifiers.has('Shift'),
    alt: modifiers.has('Alt'),
  };
}

/** Whether a letter key, whose case says whether Shift was held, rather than a symbol. */
const isLetter = (key: string) => /^[a-z]$/i.test(key);

/** Whether a key press is this shortcut, on a platform where `Mod` is ⌘ or Ctrl. */
export function matches(shortcut: Shortcut, press: KeyPress, isApple: boolean): boolean {
  const wanted = parse(shortcut);
  const mod = isApple ? press.metaKey : press.ctrlKey;
  const other = isApple ? press.ctrlKey : press.metaKey;
  if (mod !== wanted.mod || other || press.altKey !== wanted.alt) return false;
  if (isLetter(wanted.key)) {
    return press.key.toLowerCase() === wanted.key.toLowerCase() && press.shiftKey === wanted.shift;
  }
  return press.key === wanted.key;
}

/** A shortcut as a key cap reads: `⌘K` or `Ctrl+K`, `⇧U`, `E`, `#`. */
export function label(shortcut: Shortcut, isApple: boolean): string {
  const { key, mod, shift, alt } = parse(shortcut);
  const shown = isLetter(key) ? key.toUpperCase() : key;
  if (isApple) return `${mod ? '⌘' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${shown}`;
  return [mod && 'Ctrl', alt && 'Alt', shift && 'Shift', shown].filter(Boolean).join('+');
}

/** Whether a shortcut works while typing in a field, as one with a modifier or Escape does. */
export const worksWhileTyping = (shortcut: Shortcut) =>
  parse(shortcut).mod || parse(shortcut).key === 'Escape';

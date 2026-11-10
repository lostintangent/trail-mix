import type { LucideIcon } from 'lucide-react';
import { createContext, use, useEffect, useLayoutEffect, useRef } from 'react';
import { worksWhileTyping } from './core/keys.ts';
import { commandFor, matching, type CommandLike } from './core/registry.ts';

/**
 * Every action is a command. One registry feeds the palette, the shortcut sheet and the visible
 * controls, so a key can't exist without its palette entry and its button. Each feature exports the
 * commands for the state it owns, and the workbench gathers them into the registry.
 */
export type Command = CommandLike & {
  icon?: LucideIcon;
  /** A toggle's state, such as whether the conversation is flagged. */
  isChecked?: boolean;
  /** Whether it can't be taken back, as a delete can't, which a menu marks in the danger color. */
  isDestructive?: boolean;
  run: () => unknown;
};

/** Whether `Mod` means ⌘, as on Apple platforms, rather than Ctrl. */
export const isApple =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The registry: the commands the workbench has gathered, for the palette and the shortcut sheet. */
export const Commands = createContext<readonly Command[]>([]);

export const useCommands = () => use(Commands);

let bound: readonly Command[] = [];

/**
 * Runs the command a key press names, unless the press belongs to typing. The window's keys come
 * here, and so do the keys pressed inside a message, which the reader hands on.
 */
export function runCommandKey(event: KeyboardEvent) {
  // A key that composes text in an input method isn't a shortcut, and neither is one handled.
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  const command = commandFor(bound, event, isApple);
  if (!command?.shortcut) return;
  const target = event.target instanceof Element ? event.target : null;
  const isTyping = target?.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  );
  if (isTyping && !worksWhileTyping(command.shortcut)) return;
  event.preventDefault();
  void command.run();
}

/**
 * The commands as the same objects for as long as each looks the same, so a control drawn from one
 * renders again only when what it shows changes, not each time the commands are made anew, as for
 * each conversation the reader opens. The list stays the same while every command in it does.
 * Running one runs the latest command of its id, so a control that didn't render again still acts
 * on what is shown now.
 */
export function useSteadyCommands(commands: readonly Command[]): readonly Command[] {
  const latest = useRef(commands);
  useLayoutEffect(() => {
    latest.current = commands;
  });
  const kept = useRef<readonly Command[]>([]);
  const before = kept.current;
  const now = commands.map((command) => {
    const held = before.find(({ id }) => id === command.id);
    return held && looksSame(command, held)
      ? held
      : { ...command, run: () => latest.current.find(({ id }) => id === command.id)?.run() };
  });
  if (now.length !== before.length || now.some((command, at) => command !== before[at])) {
    kept.current = now;
  }
  return kept.current;
}

/** Whether two commands show the same: alike in everything but what running each does. */
function looksSame(a: Command, b: Command): boolean {
  const { run: _a, ...shownA } = a;
  const { run: _b, ...shownB } = b;
  const keys = Object.keys(shownA) as (keyof typeof shownA)[];
  return (
    keys.length === Object.keys(shownB).length && keys.every((key) => shownA[key] === shownB[key])
  );
}

/** Binds the registry's keys while the component that gathers it is mounted. */
export function useCommandKeys(commands: readonly Command[]) {
  useLayoutEffect(() => {
    bound = commands;
  }, [commands]);
  useEffect(() => {
    addEventListener('keydown', runCommandKey);
    return () => removeEventListener('keydown', runCommandKey);
  }, []);
}

let searchFocus: (() => void) | undefined;

/**
 * The search box says how to focus it, and ⌘K's command calls that. It lives wherever the box
 * sits, so the box registers itself while mounted. Returns how to unregister.
 */
export function registerSearchFocus(focus: () => void): () => void {
  searchFocus = focus;
  return () => {
    if (searchFocus === focus) searchFocus = undefined;
  };
}

export const focusSearch = () => searchFocus?.();

/** The id of the command that opens the palette, which the palette leaves out of what it offers. */
export const SEARCH_COMMAND = 'search.focus';

/** How many commands the palette offers at once, best first. */
const PALETTE_SIZE = 8;

/**
 * The commands the palette offers for what's been typed, best first: every match but the command
 * that opens the palette, which does nothing from inside it.
 */
export function paletteOf(commands: readonly Command[], text: string): Command[] {
  return matching(commands, text)
    .filter(({ id }) => id !== SEARCH_COMMAND)
    .slice(0, PALETTE_SIZE);
}

/**
 * The palette's best match for what's in the field at this moment, from the commands bound now,
 * for an Enter pressed before the palette has drawn what was typed.
 */
export const bestCommandFor = (text: string): Command | undefined => paletteOf(bound, text)[0];

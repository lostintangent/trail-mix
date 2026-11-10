import type { LucideIcon } from 'lucide-react';
import { createContext, use, useEffect, useLayoutEffect } from 'react';
import { worksWhileTyping } from './core/keys.ts';
import { commandFor, type CommandLike } from './core/registry.ts';

/**
 * Every action is a command. One registry feeds the palette, the shortcut sheet and the visible
 * controls, so a key can't exist without its palette entry and its button. Each feature exports the
 * commands for the state it owns, and the workbench gathers them into the registry.
 */
export type Command = CommandLike & {
  icon?: LucideIcon;
  /** A toggle's state, such as whether the conversation is flagged. */
  isChecked?: boolean;
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

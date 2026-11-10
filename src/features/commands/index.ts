export { label as shortcutLabel } from './core/keys.ts';
export { commandFor, matching, problemsOf } from './core/registry.ts';
export {
  Commands,
  focusSearch,
  isApple,
  registerSearchFocus,
  runCommandKey,
  useCommandKeys,
  useCommands,
  type Command,
} from './registry.ts';
export { CommandButton } from './ui/CommandButton.tsx';
export { CommandMatches, ShortcutSheet } from './ui/lazy.ts';
export type { PaletteKeys } from './ui/CommandMatches.tsx';

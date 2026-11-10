import { ChevronLeft, ChevronRight, Keyboard, Search, Undo2 } from 'lucide-react';
import type { Command } from '../../commands/index.ts';

/**
 * The workbench's own commands: moving through the list, going back, undoing the last triage,
 * finding a search or a command, and the shortcut sheet. One that has nothing to act on now, such
 * as Back with nowhere to go, can't run, so its key does nothing.
 */
export function workbenchCommands({
  next,
  previous,
  back,
  undo,
  focusSearch,
  showShortcuts,
}: {
  next: (() => void) | undefined;
  previous: (() => void) | undefined;
  back: (() => void) | undefined;
  undo: (() => void) | undefined;
  focusSearch: () => void;
  showShortcuts: () => void;
}): Command[] {
  return [
    {
      id: 'list.next',
      title: 'Next conversation',
      group: 'Move',
      shortcut: 'J',
      icon: ChevronRight,
      isEnabled: next !== undefined,
      run: () => next?.(),
    },
    {
      id: 'list.previous',
      title: 'Previous conversation',
      group: 'Move',
      shortcut: 'K',
      icon: ChevronLeft,
      isEnabled: previous !== undefined,
      run: () => previous?.(),
    },
    {
      id: 'workbench.back',
      title: 'Back',
      group: 'Move',
      shortcut: 'Escape',
      isEnabled: back !== undefined,
      run: () => back?.(),
    },
    {
      id: 'conversation.undo',
      title: 'Undo',
      group: 'Conversation',
      shortcut: 'Z',
      icon: Undo2,
      isEnabled: undo !== undefined,
      run: () => undo?.(),
    },
    {
      id: 'search.focus',
      title: 'Search and commands',
      group: 'Search',
      shortcut: 'Mod+K',
      icon: Search,
      run: focusSearch,
    },
    {
      id: 'help.shortcuts',
      title: 'Keyboard shortcuts',
      group: 'Help',
      shortcut: '?',
      icon: Keyboard,
      run: showShortcuts,
    },
  ];
}

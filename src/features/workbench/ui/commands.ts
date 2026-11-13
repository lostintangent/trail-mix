import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
} from 'lucide-react';
import { SEARCH_COMMAND, UNDO_COMMAND, type Command } from '../../commands/index.ts';

/** The id of the command that folds the sidebar to its rail and back. */
export const FOLD_SIDEBAR = 'sidebar.fold';

/** The id of the command that opens Settings, which the gear at the foot of the sidebar runs. */
export const OPEN_SETTINGS = 'settings.open';

/**
 * The workbench's own commands: moving through the list, going back, undoing the last triage,
 * finding a search or a command, folding the sidebar, Settings, and the shortcut sheet. One that
 * has nothing to act on now, such as Back with nowhere to go, can't run, so its key does nothing.
 */
export function workbenchCommands({
  next,
  previous,
  back,
  undo,
  focusSearch,
  fold,
  openSettings,
  showShortcuts,
}: {
  next: (() => void) | undefined;
  previous: (() => void) | undefined;
  back: (() => void) | undefined;
  undo: (() => void) | undefined;
  focusSearch: () => void;
  /** Folds or unfolds the sidebar, where it can fold, as a desktop's does. */
  fold: { isFolded: boolean; toggle: () => void } | undefined;
  openSettings: () => void;
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
      id: UNDO_COMMAND,
      title: 'Undo',
      group: 'Conversation',
      shortcut: 'Z',
      menuIcon: 'undo',
      isEnabled: undo !== undefined,
      run: () => undo?.(),
    },
    {
      id: SEARCH_COMMAND,
      title: 'Search and commands',
      group: 'Search',
      shortcut: 'Mod+K',
      icon: Search,
      run: focusSearch,
    },
    {
      id: FOLD_SIDEBAR,
      title: fold?.isFolded ? 'Unfold the sidebar' : 'Fold the sidebar',
      group: 'View',
      shortcut: 'Mod+B',
      icon: fold?.isFolded ? PanelLeftOpen : PanelLeftClose,
      isChecked: fold !== undefined && !fold.isFolded,
      isEnabled: fold !== undefined,
      run: () => fold?.toggle(),
    },
    {
      id: OPEN_SETTINGS,
      title: 'Open settings',
      group: 'View',
      icon: Settings,
      run: openSettings,
    },
    {
      id: 'help.shortcuts',
      title: 'Keyboard shortcuts',
      group: 'Help',
      shortcut: '?',
      menuIcon: 'keyboard',
      run: showShortcuts,
    },
  ];
}

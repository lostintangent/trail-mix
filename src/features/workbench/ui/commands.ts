import {
  ChevronLeft,
  ChevronRight,
  ListFilter,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
} from 'lucide-react';
import { SEARCH_COMMAND, UNDO_COMMAND, type Command } from '../../commands/index.ts';
import type { ConversationId } from '../../mail/core/index.ts';
import type { ComposerPlace } from './ReaderPane.tsx';

/** The id of the command that folds the sidebar to its rail and back. */
export const FOLD_SIDEBAR = 'sidebar.fold';

/** The id of the command that opens Settings, which the gear at the foot of the sidebar runs. */
export const OPEN_SETTINGS = 'settings.open';

/** The id of the command that lists only the view's unread mail and back, as the list's toggle does. */
export const UNREAD_ONLY = 'view.unread';

/**
 * The workbench's own commands: moving through the list, going back, undoing the last triage,
 * finding a search or a command, listing only unread mail, folding the sidebar, Settings, and the
 * shortcut sheet. One that has nothing to act on now, such as Back with nowhere to go, can't run, so
 * its key does nothing.
 */
export function workbenchCommands({
  next,
  previous,
  back,
  undo,
  focusSearch,
  unread,
  fold,
  openSettings,
  showShortcuts,
}: {
  next: (() => void) | undefined;
  previous: (() => void) | undefined;
  back: (() => void) | undefined;
  undo: (() => void) | undefined;
  focusSearch: () => void;
  /**
   * Lists only the view's unread mail, or all of it again, where the view has unread mail or
   * already lists only that.
   */
  unread: { isOn: boolean; toggle: () => void } | undefined;
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
      id: UNREAD_ONLY,
      title: unread?.isOn ? 'Show all conversations' : 'Show only unread',
      group: 'View',
      icon: ListFilter,
      isChecked: unread?.isOn === true,
      isEnabled: unread !== undefined,
      run: () => unread?.toggle(),
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

/** The pane a phone shows, one at a time on its sliding track. */
export type PhonePane = 'sidebar' | 'list' | 'reader';

/**
 * What the composer leaves of the conversation open in the reader for the commands to act on. A new
 * message fills the reader, and on a phone any composer lies over it, so neither keys nor the
 * palette act on the conversation behind it or move the list from under it. Keys typed straight
 * after New message, before its fields are drawn, then do nothing. A reply docked under its
 * conversation leaves it to them, and one on its way to its editor counts as the composer too,
 * while its conversation stays in view with its place in the list.
 */
export function readerCover({
  composer,
  isReplyOnItsWay,
  open,
}: {
  composer: ComposerPlace | undefined;
  isReplyOnItsWay: boolean;
  /** The one conversation open in the reader, if one is rather than none or several picked. */
  open: ConversationId | undefined;
}) {
  const isOverReader = composer !== undefined && composer !== 'docked';
  const isBehindComposer = isOverReader || isReplyOnItsWay;
  /** The conversation the member can see, if any. */
  const inView = isOverReader ? undefined : open;
  /** The conversation the commands act on, if any. */
  const openInView = isBehindComposer ? undefined : inView;
  return { isOverReader, isBehindComposer, inView, openInView };
}

/**
 * What Back closes, the nearest first: a page, the composer, a thread in its bundle, and then on a
 * phone the reader or the sidebar for the list, or on a desktop a selection of several.
 */
export function backFrom({
  isPageOpen,
  isComposing,
  isThreadOpen,
  phonePane,
  isMany,
}: {
  isPageOpen: boolean;
  isComposing: boolean;
  isThreadOpen: boolean;
  /** The pane a phone shows, or none on a desktop. */
  phonePane: PhonePane | undefined;
  isMany: boolean;
}): 'page' | 'composer' | 'thread' | 'reader' | 'sidebar' | 'selection' | undefined {
  if (isPageOpen) return 'page';
  if (isComposing) return 'composer';
  if (isThreadOpen) return 'thread';
  if (phonePane !== undefined) return phonePane === 'list' ? undefined : phonePane;
  return isMany ? 'selection' : undefined;
}

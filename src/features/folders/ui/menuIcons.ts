import {
  Code,
  Eraser,
  FolderPen,
  FolderPlus,
  FolderX,
  Keyboard,
  LogIn,
  MailMinus,
  RotateCw,
  Settings2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { Command, MenuIconName } from '../../commands/index.ts';

/**
 * The icons commands only menus draw, by the names they give. They load with the menus, apart from
 * the first screen. A name with no icon here, or an icon with no name, fails the type check.
 */
export const MENU_ICONS = {
  code: Code,
  eraser: Eraser,
  folderPen: FolderPen,
  folderPlus: FolderPlus,
  folderX: FolderX,
  keyboard: Keyboard,
  logIn: LogIn,
  mailMinus: MailMinus,
  rotateCw: RotateCw,
  settings: Settings2,
  undo: Undo2,
} as const satisfies Record<MenuIconName, LucideIcon>;

/** The icon a menu draws for a command: its own, or the one it names. */
export function menuIconOf({ icon, menuIcon }: Command): LucideIcon | undefined {
  return icon ?? (menuIcon && MENU_ICONS[menuIcon]);
}

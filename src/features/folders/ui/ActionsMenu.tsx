import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { useEffect, useRef, useState } from 'react';
import { isApple, shortcutLabel, type Command } from '../../commands/index.ts';
import { MoreButton } from './MoreButton.tsx';

/**
 * A sidebar row's menu, which loads apart from the first screen and opens as it mounts, once the
 * row's `…` is first pressed. It asks for the row's actions only while open, so a closed menu costs the
 * sidebar nothing as it renders.
 */
export function ActionsMenu({
  label,
  actions,
}: {
  label: string;
  actions: () => readonly Command[];
}) {
  const [isOpen, setOpen] = useState(false);
  const button = useRef<HTMLElement>(null);
  // It takes the place of the button that was pressed, so it takes that button's focus too, then
  // opens, as the menu would from its own button: arrows move into it, and Escape comes back.
  useEffect(() => {
    button.current?.focus();
    setOpen(true);
  }, []);
  return (
    <DropdownMenu
      renderTrigger={({ ref, ...trigger }) => (
        <MoreButton
          label={label}
          ref={(element) => {
            ref(element);
            button.current = element;
          }}
          {...trigger}
        />
      )}
      items={isOpen ? menuItems(actions()) : CLOSED}
      isMenuOpen={isOpen}
      onOpenChange={setOpen}
    />
  );
}

/** Commands as a menu's items, leaving out those that can't run now. */
export function menuItems(commands: readonly Command[]): DropdownMenuOption[] {
  return commands
    .filter((command) => command.isEnabled !== false)
    .map((command) => ({
      id: command.id,
      label: command.title,
      icon: command.icon && <Icon icon={command.icon} />,
      ...(command.shortcut ? { endContent: shortcutLabel(command.shortcut, isApple) } : {}),
      ...(command.isDestructive ? { variant: 'destructive' as const } : {}),
      onClick: () => void command.run(),
    }));
}

const CLOSED: DropdownMenuOption[] = [];

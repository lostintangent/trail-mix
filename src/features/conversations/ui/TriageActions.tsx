import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis, FolderInput } from 'lucide-react';
import { memo, Suspense, useMemo, useRef, useState, type ReactNode } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { preloadable } from '../../../shared/preloadable.ts';
import { CommandButton, useSteadyCommands, type Command } from '../../commands/index.ts';
import { MOVE } from './commands.ts';

/**
 * The triage controls, drawn from the triage commands: filing, which is archive and delete and a
 * menu of folders to move to, then marking, which is flag and a menu of more that marks read or
 * unread. A flagged conversation's star is marked with the highlighter. Where room is short, as in
 * a phone's island, flagging joins the menu of more. A phone's reader splits the two parts between
 * the top of the screen and the island.
 *
 * The reader makes its commands anew for each conversation it opens, though they mostly look the
 * same, so the controls draw from steady commands and render again only where something changed.
 *
 * The controls draw with the first screen, in the list's header. Only what their menus open loads
 * apart from it.
 */
export function TriageActions({
  commands,
  part = 'all',
  isCompact = false,
}: {
  commands: readonly Command[];
  part?: 'all' | 'filing' | 'marking';
  isCompact?: boolean;
}) {
  const steady = useSteadyCommands(commands);
  const command = (id: string) => steady.find((each) => each.id === id);
  const archive = command('conversation.archive');
  const remove = command('conversation.delete');
  const flag = command('conversation.flag');
  // Each menu's items stay the same while its own commands do.
  const moving = useSteadyCommands(steady.filter(({ id }) => id.startsWith(MOVE)));
  const marking = useSteadyCommands(
    [
      ...(isCompact && flag ? [flag] : []),
      ...['conversation.read', 'conversation.unread'].flatMap((id) => command(id) ?? []),
    ].filter(({ isEnabled }) => isEnabled !== false),
  );
  const moves = useMemo(() => moving.map(asItem), [moving]);
  const more = useMemo(() => marking.map(asItem), [marking]);

  const isFiling = part !== 'marking';
  const isMarking = part !== 'filing';

  return (
    <>
      {isFiling && archive && <CommandButton command={archive} />}
      {isFiling && remove && <CommandButton command={remove} />}
      {isFiling && <Menu label="Move to" icon={MOVE_ICON} items={moves} />}
      {isMarking && flag && !isCompact && (
        <CommandButton command={flag} iconStyle={flag.isChecked && styles.flagged} />
      )}
      {isMarking && <Menu label="More" icon={MORE_ICON} items={more} />}
    </>
  );
}

const asItem = ({ id, title, run }: Command): DropdownMenuOption => ({
  id,
  label: title,
  onClick: () => void run(),
});

const MOVE_ICON = <Icon icon={FolderInput} />;
const MORE_ICON = <Icon icon={Ellipsis} />;

/**
 * The design system's menus, which load apart from the first screen, with a way to load them ahead
 * of need, as once the reader is wanted.
 */
const { Component: DropdownMenu, preload: preloadTriageMenus } = preloadable(
  async () => (await import('@astryxdesign/core/DropdownMenu')).DropdownMenu,
);
export { preloadTriageMenus };

/**
 * A menu behind an icon button, which renders again only when its items change. Its items are drawn
 * only while it is open, so a conversation opened while the menu is closed costs it nothing. With no
 * items, as while nothing is open, its button is disabled.
 *
 * Until the menu's code has come, the same button stands in its place: a pointer or focus reaching
 * it asks for the code, a press opens the menu once the code is here, and focus passes to the
 * menu's own button.
 */
const Menu = memo(function Menu({
  label,
  icon,
  items,
}: {
  label: string;
  icon: ReactNode;
  items: DropdownMenuOption[];
}) {
  const [isOpen, setOpen] = useState(false);
  const isFocused = useRef(false);
  const button = {
    label,
    tooltip: label,
    icon,
    isIconOnly: true,
    variant: 'ghost',
    isDisabled: items.length === 0,
  } as const;
  const standIn = (
    <Button
      {...button}
      aria-haspopup="menu"
      aria-expanded={false}
      xstyle={styles.trigger}
      onPointerEnter={() => void preloadTriageMenus()}
      onFocus={() => {
        isFocused.current = true;
        void preloadTriageMenus();
      }}
      onBlur={() => (isFocused.current = false)}
      onClick={() => {
        setOpen(true);
        void preloadTriageMenus();
      }}
    />
  );
  return (
    <Suspense fallback={standIn}>
      <DropdownMenu
        button={{
          ...button,
          ref: (trigger: HTMLButtonElement | null) => {
            if (!trigger || !isFocused.current) return;
            isFocused.current = false;
            trigger.focus();
          },
        }}
        hasChevron={false}
        items={isOpen ? items : CLOSED}
        isMenuOpen={isOpen}
        onOpenChange={setOpen}
      />
    </Suspense>
  );
});

const CLOSED: DropdownMenuOption[] = [];

const styles = stylex.create({
  // As the menu's own button, which a long press doesn't select or call out.
  trigger: {
    userSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  flagged: {
    color: tm.highlight,
    fill: tm.highlight,
  },
});

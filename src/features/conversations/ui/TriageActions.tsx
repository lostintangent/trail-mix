import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis, FolderInput } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
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
 * A menu behind an icon button, which renders again only when its items change. Its items are drawn
 * only while it is open, so a conversation opened while the menu is closed costs it nothing. With no
 * items, as while nothing is open, its button is disabled.
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
  return (
    <DropdownMenu
      button={{
        label,
        tooltip: label,
        icon,
        isIconOnly: true,
        variant: 'ghost',
        isDisabled: items.length === 0,
      }}
      hasChevron={false}
      items={isOpen ? items : CLOSED}
      isMenuOpen={isOpen}
      onOpenChange={setOpen}
    />
  );
});

const CLOSED: DropdownMenuOption[] = [];

const styles = stylex.create({
  flagged: {
    color: tm.highlight,
    fill: tm.highlight,
  },
});

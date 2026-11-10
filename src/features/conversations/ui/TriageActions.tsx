import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis, FolderInput } from 'lucide-react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { CommandButton, type Command } from '../../commands/index.ts';
import { MOVE } from './commands.ts';

/**
 * The triage controls, drawn from the triage commands: filing, which is archive and delete and a
 * menu of folders to move to, then marking, which is flag and a menu of more that marks read or
 * unread. A flagged conversation's star is marked with the highlighter. Where room is short, as in
 * a phone's island, flagging joins the menu of more. A phone's reader splits the two parts between
 * the top of the screen and the island.
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
  const command = (id: string) => commands.find((each) => each.id === id);
  const archive = command('conversation.archive');
  const remove = command('conversation.delete');
  const flag = command('conversation.flag');
  const asItem = ({ id, title, run }: Command): DropdownMenuOption => ({
    id,
    label: title,
    onClick: () => void run(),
  });
  const moves = commands.filter(({ id }) => id.startsWith(MOVE)).map(asItem);
  const more = [
    ...(isCompact && flag ? [flag] : []),
    ...['conversation.read', 'conversation.unread'].flatMap((id) => command(id) ?? []),
  ]
    .filter(({ isEnabled }) => isEnabled !== false)
    .map(asItem);

  const isFiling = part !== 'marking';
  const isMarking = part !== 'filing';

  return (
    <>
      {isFiling && archive && <CommandButton command={archive} />}
      {isFiling && remove && <CommandButton command={remove} />}
      {isFiling && (
        <DropdownMenu
          button={{
            label: 'Move to',
            tooltip: 'Move to',
            icon: <Icon icon={FolderInput} />,
            isIconOnly: true,
            variant: 'ghost',
          }}
          hasChevron={false}
          items={moves}
        />
      )}
      {isMarking && flag && !isCompact && (
        <CommandButton command={flag} iconStyle={flag.isChecked && styles.flagged} />
      )}
      {isMarking && (
        <DropdownMenu
          button={{
            label: 'More',
            tooltip: 'More',
            icon: <Icon icon={Ellipsis} />,
            isIconOnly: true,
            variant: 'ghost',
          }}
          hasChevron={false}
          items={more}
        />
      )}
    </>
  );
}

const styles = stylex.create({
  flagged: {
    color: tm.highlight,
    fill: tm.highlight,
  },
});

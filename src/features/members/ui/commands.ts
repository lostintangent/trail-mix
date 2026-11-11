import { Users } from 'lucide-react';
import type { Command } from '../../commands/index.ts';

/** Opening Members, in Settings, which exists only for the operator. */
export function memberCommands(open: (() => void) | undefined): Command[] {
  return open
    ? [{ id: 'members.open', title: 'Members', group: 'Members', icon: Users, run: open }]
    : [];
}

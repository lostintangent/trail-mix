import { SideNav, SideNavItem } from '@astryxdesign/core/SideNav';
import * as stylex from '@stylexjs/stylex';
import { File, Inbox, Send, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/** The views that gather mail across every account. */
export const VIEWS = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'flagged', label: 'Flagged', icon: Star },
  { id: 'drafts', label: 'Drafts', icon: File },
  { id: 'outbox', label: 'Outbox', icon: Send },
] as const;

export type UnifiedView = (typeof VIEWS)[number]['id'];

/** The sidebar, lying directly on the desk. */
export function Sidebar({
  view,
  onSelect,
  footer,
}: {
  view: UnifiedView;
  onSelect: (view: UnifiedView) => void;
  footer: ReactNode;
}) {
  return (
    <SideNav footer={footer} xstyle={styles.sidebar}>
      {VIEWS.map(({ id, label, icon }) => (
        <SideNavItem
          key={id}
          label={label}
          icon={icon}
          isSelected={id === view}
          onClick={() => onSelect(id)}
        />
      ))}
    </SideNav>
  );
}

const styles = stylex.create({
  sidebar: {
    width: '100%',
    height: '100%',
    paddingTop: { default: null, [media.phone]: tm.safeTop },
    paddingBottom: { default: null, [media.phone]: tm.safeBottom },
  },
});

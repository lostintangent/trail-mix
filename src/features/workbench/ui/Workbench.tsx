import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useState, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { ListPane } from './ListPane.tsx';
import { ReaderPane } from './ReaderPane.tsx';
import { Sidebar, VIEWS, type UnifiedView } from './Sidebar.tsx';
import { useMediaQuery } from './useMediaQuery.ts';

type Pane = 'sidebar' | 'list' | 'reader';

/**
 * The desk and what lies on it: the sidebar directly on the desk, then the list and reader sheets.
 * Below 768 pixels the three panes ride a horizontal track, and one shows at a time.
 */
export function Workbench({ sidebarFooter }: { sidebarFooter: ReactNode }) {
  const [view, setView] = useState<UnifiedView>('inbox');
  const [phonePane, setPhonePane] = useState<Pane>('list');
  const isPhone = useMediaQuery(media.phone);
  // Panes off a phone's screen are inert, so focus and assistive tech stay on the one in view.
  const isOffscreen = (pane: Pane) => isPhone && pane !== phonePane;

  return (
    <div {...stylex.props(styles.desk)}>
      <div {...stylex.props(styles.track, trackAt[phonePane])}>
        <div inert={isOffscreen('sidebar')} {...stylex.props(styles.pane)}>
          <Sidebar
            view={view}
            onSelect={(next) => {
              setView(next);
              setPhonePane('list');
            }}
            footer={sidebarFooter}
          />
        </div>
        <div inert={isOffscreen('list')} {...stylex.props(styles.pane)}>
          <ListPane
            title={VIEWS.find(({ id }) => id === view)?.label ?? ''}
            onShowFolders={() => setPhonePane('sidebar')}
          />
        </div>
        <div inert={isOffscreen('reader')} {...stylex.props(styles.pane)}>
          <ReaderPane />
        </div>
      </div>
    </div>
  );
}

const styles = stylex.create({
  desk: {
    height: '100dvh',
    overflow: 'hidden',
    backgroundColor: colorVars['--color-background-body'],
  },
  track: {
    display: { default: 'grid', [media.phone]: 'flex' },
    gridTemplateColumns: `${tm.sidebarWidth} ${tm.listWidth} minmax(0, 1fr)`,
    gap: { default: tm.deskGap, [media.phone]: 0 },
    padding: { default: tm.deskGap, [media.phone]: 0 },
    width: { default: '100%', [media.phone]: '300%' },
    height: '100%',
    transitionProperty: { default: null, [media.phone]: 'transform' },
    transitionDuration: {
      default: null,
      [media.phone]: { default: durationVars['--duration-medium'], [media.reducedMotion]: '0s' },
    },
    transitionTimingFunction: { default: null, [media.phone]: tm.easeLayout },
  },
  pane: {
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    flexBasis: { default: null, [media.phone]: 0 },
    flexGrow: { default: null, [media.phone]: 1 },
  },
});

const trackAt = stylex.create({
  sidebar: { transform: { default: null, [media.phone]: 'translateX(0)' } },
  list: { transform: { default: null, [media.phone]: 'translateX(calc(-100% / 3))' } },
  reader: { transform: { default: null, [media.phone]: 'translateX(calc(-200% / 3))' } },
});

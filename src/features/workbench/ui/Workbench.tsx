import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useId, useState, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { ListPane } from './ListPane.tsx';
import { PanelEdge } from './PanelEdge.tsx';
import { PANELS } from './panels.ts';
import { ReaderPane } from './ReaderPane.tsx';
import { Sidebar, VIEWS, type UnifiedView } from './Sidebar.tsx';
import { useMediaQuery } from './useMediaQuery.ts';
import { usePanel } from './usePanel.ts';

type Pane = 'sidebar' | 'list' | 'reader';

/** The desktop columns: each side panel at the size on its custom property, then the reader. */
const COLUMNS = `var(${PANELS.sidebar.variable}) var(${PANELS.list.variable}) minmax(0, 1fr)`;

/**
 * The desk and what lies on it: the sidebar directly on the desk, then the list and reader sheets.
 * On a desktop the sidebar and the list are side panels, resized by their edges. Below 768 pixels
 * the three panes ride a horizontal track, and one shows at a time.
 */
export function Workbench({ sidebarFooter }: { sidebarFooter: ReactNode }) {
  const [view, setView] = useState<UnifiedView>('inbox');
  const [phonePane, setPhonePane] = useState<Pane>('list');
  const [sidebar, setSidebar] = usePanel(PANELS.sidebar);
  const [list, setList] = usePanel(PANELS.list);
  const [isResizing, setIsResizing] = useState(false);
  const isPhone = useMediaQuery(media.phone);
  const sidebarId = useId();
  const listId = useId();
  const title = VIEWS.find(({ id }) => id === view)?.label ?? '';
  // Panes off a phone's screen are inert, so focus and assistive tech stay on the one in view.
  const isOffscreen = (pane: Pane) => isPhone && pane !== phonePane;

  return (
    <div {...stylex.props(styles.desk)}>
      <div
        {...stylex.props(
          styles.track,
          styles.columns(COLUMNS),
          trackAt[phonePane],
          isResizing && styles.resizing,
        )}
      >
        <div inert={isOffscreen('sidebar')} {...stylex.props(styles.pane)}>
          <Sidebar
            id={sidebarId}
            view={view}
            onSelect={(next) => {
              setView(next);
              setPhonePane('list');
            }}
            isCollapsed={!isPhone && sidebar.isCollapsed}
            footer={sidebarFooter}
          />
          <PanelEdge
            spec={PANELS.sidebar}
            state={sidebar}
            label="Resize the sidebar"
            controls={sidebarId}
            onChange={setSidebar}
            onResizingChange={setIsResizing}
          />
        </div>
        <div inert={isOffscreen('list')} {...stylex.props(styles.pane)}>
          <ListPane
            id={listId}
            title={title}
            isCollapsed={!isPhone && list.isCollapsed}
            onExpand={() => setList({ ...list, isCollapsed: false })}
            onShowFolders={() => setPhonePane('sidebar')}
          />
          <PanelEdge
            spec={PANELS.list}
            state={list}
            label="Resize the conversation list"
            controls={listId}
            onChange={setList}
            onResizingChange={setIsResizing}
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
    gap: { default: tm.deskGap, [media.phone]: 0 },
    padding: { default: tm.deskGap, [media.phone]: 0 },
    width: { default: '100%', [media.phone]: '300%' },
    height: '100%',
    // Panes and the phone track move on the layout easing, and nothing moves under reduced motion.
    transitionProperty: { default: 'grid-template-columns', [media.phone]: 'transform' },
    transitionDuration: {
      default: durationVars['--duration-medium'],
      [media.reducedMotion]: '0s',
    },
    transitionTimingFunction: tm.easeLayout,
  },
  columns: (columns: string) => ({ gridTemplateColumns: columns }),
  // An edge being dragged moves its panel with the pointer, not after it.
  resizing: {
    transitionDuration: '0s',
  },
  pane: {
    position: 'relative',
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

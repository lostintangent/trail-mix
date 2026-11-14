import { durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo, useRef, useState, type PointerEvent } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { dragPanel, nudgePanel, panelSize, type PanelSpec, type PanelState } from './panels.ts';

/**
 * The draggable edge on a side panel's inline end, in the gutter beside it: the sidebar's margin
 * from the list, or the gap between two sheets. It moves the panel's width by pointer and by key, and
 * past the midpoint toward the rail it collapses the panel.
 *
 * While a pointer drags, the edge writes the size straight to the panel's custom property, so
 * following the pointer re-renders only the edge. The panel's owner hears about a width when the
 * drag ends, and about collapsing the moment it happens, since the panel then changes form.
 */
export const PanelEdge = memo(function PanelEdge({
  spec,
  state,
  label,
  controls,
  gutter,
  onChange,
  onResizingChange,
}: {
  spec: PanelSpec;
  state: PanelState;
  label: string;
  /** The id of the panel the edge resizes. */
  controls: string;
  /** The gutter the edge fills: the sidebar's margin from the list, or the gap between sheets. */
  gutter: 'desk' | 'sheets';
  onChange: (state: PanelState) => void;
  onResizingChange: (isResizing: boolean) => void;
}) {
  const [drag, setDrag] = useState<PanelState | null>(null);
  const origin = useRef<{ pointer: number; size: number } | null>(null);
  const shown = drag ?? state;

  const follow = (next: PanelState) => {
    document.documentElement.style.setProperty(spec.variable, `${panelSize(spec, next)}px`);
    if (next.isCollapsed !== shown.isCollapsed) onChange(next);
    setDrag(next);
  };

  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    origin.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag) onChange(drag);
    setDrag(null);
    onResizingChange(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={panelSize(spec, shown)}
      aria-valuemin={spec.rail}
      aria-valuemax={spec.max}
      tabIndex={0}
      {...stylex.props(styles.edge, gutters[gutter], drag && styles.dragging)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = { pointer: event.clientX, size: panelSize(spec, state) };
        setDrag(state);
        onResizingChange(true);
      }}
      onPointerMove={(event) => {
        if (origin.current) {
          const edge = origin.current.size + event.clientX - origin.current.pointer;
          follow(dragPanel(spec, state, edge));
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange({ ...state, isCollapsed: !state.isCollapsed })}
      onKeyDown={(event) => {
        const next = nudgePanel(spec, state, event.key);
        if (!next) return;
        event.preventDefault();
        onChange(next);
      }}
    />
  );
});

const styles = stylex.create({
  edge: {
    display: { default: 'block', [media.phone]: 'none' },
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: '100%',
    zIndex: 1,
    cursor: 'col-resize',
    touchAction: 'none',
    userSelect: 'none',
    // The accent line marks focus, except under forced colors, which erase it.
    outline: {
      default: 'none',
      ':focus-visible': { default: 'none', [media.forcedColors]: '2px solid Highlight' },
    },
    // Under a finger the edge takes presses across a full target's width. A mouse takes it in the
    // gutter alone, so the sheets either side keep their edges, and the list its scrollbar.
    '::before': {
      content: { default: null, [media.coarse]: '""' },
      position: 'absolute',
      insetBlock: 0,
    },
    // Nothing shows at rest. On hover or drag a line of the accent runs down the middle of the desk
    // the gutter shows, fading out toward both ends, as Toy Box's does. For the keyboard's focus it
    // is three pixels wide, as Toy Box rings its rule, so it stays centered on whole pixels.
    '::after': {
      content: '""',
      position: 'absolute',
      insetBlock: 0,
      marginInline: 'auto',
      width: { default: '1px', ':focus-visible': '3px' },
      backgroundImage: tm.resizeAccent,
      opacity: { default: 0, ':hover': 1, ':focus-visible': 1 },
      transitionProperty: 'opacity',
      transitionDuration: {
        default: durationVars['--duration-fast'],
        [media.reducedMotion]: '0s',
      },
    },
  },
  dragging: {
    '::after': { opacity: 1 },
  },
});

// Each gutter's edge is as wide as the gutter, and under a finger reaches a target's width about it.
// A sheet's 1px ring lies outside it, in the gutter, so the line centers on the desk between the
// rings: the list's alone after the sidebar, and one on each side between sheets.
const gutters = stylex.create({
  desk: {
    width: tm.sidebarMargin,
    '::before': { insetInline: `calc((${tm.sidebarMargin} - ${tm.target}) / 2)` },
    '::after': { insetInlineStart: 0, insetInlineEnd: '1px' },
  },
  sheets: {
    width: tm.deskGap,
    '::before': { insetInline: `calc((${tm.deskGap} - ${tm.target}) / 2)` },
    '::after': { insetInlineStart: '1px', insetInlineEnd: '1px' },
  },
});

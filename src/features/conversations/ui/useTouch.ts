import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useRef, type MouseEvent, type PointerEvent } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { archives, driftOf } from '../core/gestures.ts';

/** How long a finger rests on a row before it starts picking. */
const LONG_PRESS_MS = 500;

/** The custom property a swipe moves its row by, which the row's place adds to its own. */
export const SWIPE = '--tm-swipe';

/**
 * What a finger does to a row. Held still for a moment, it starts picking. Moved sideways first, it
 * swipes the row, which follows it left, and let go far enough, archives it, or else slides back.
 * Moved up or down first, it scrolls the list as usual. After a long press or a swipe, the click
 * that ends it isn't a click, and a touch screen's context menu doesn't open.
 */
export function useTouch(onLongPress: () => void, onSwipe: () => void) {
  const gesture = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    row: HTMLElement;
    isSwiping: boolean;
  }>(null);
  const isClickTaken = useRef(false);
  const end = () => {
    if (gesture.current) clearTimeout(gesture.current.timer);
    gesture.current = null;
  };
  const letGo = (event: PointerEvent, canArchive: boolean) => {
    const at = gesture.current;
    end();
    if (!at?.isSwiping) return;
    isClickTaken.current = true;
    if (canArchive && archives(event.clientX - at.x, at.row.offsetWidth)) onSwipe();
    slideBack(at.row);
  };
  return {
    tookClick: () => {
      const taken = isClickTaken.current;
      isClickTaken.current = false;
      return taken;
    },
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'mouse') return;
        isClickTaken.current = false;
        const timer = setTimeout(() => {
          isClickTaken.current = true;
          gesture.current = null;
          onLongPress();
        }, LONG_PRESS_MS);
        gesture.current = {
          x: event.clientX,
          y: event.clientY,
          timer,
          row: event.currentTarget,
          isSwiping: false,
        };
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const at = gesture.current;
        if (!at) return;
        const dx = event.clientX - at.x;
        if (!at.isSwiping) {
          const drift = driftOf(dx, event.clientY - at.y);
          if (drift === 'holding') return;
          clearTimeout(at.timer);
          if (drift === 'elsewhere') return end();
          at.isSwiping = true;
          at.row.setPointerCapture(event.pointerId);
          at.row.classList.add(...classesOf(swiping.lifted));
        }
        at.row.style.setProperty(SWIPE, `${Math.min(0, dx)}px`);
      },
      onPointerUp: (event: PointerEvent) => letGo(event, true),
      onPointerCancel: (event: PointerEvent) => letGo(event, false),
      onContextMenu: (event: MouseEvent) => {
        if (isClickTaken.current || gesture.current) event.preventDefault();
      },
    },
  };
}

/** Slides a swiped row back into place, and lowers it onto the sheet again. */
function slideBack(row: HTMLElement) {
  const settling = classesOf(swiping.settling);
  row.classList.add(...settling);
  row.style.setProperty(SWIPE, '0px');
  const done = () => row.classList.remove(...settling, ...classesOf(swiping.lifted));
  row.addEventListener('transitionend', done, { once: true });
  // Under reduced motion there is no transition to end.
  setTimeout(done, 300);
}

const classesOf = (style: stylex.StyleXStyles) => stylex.props(style).className?.split(' ') ?? [];

const swiping = stylex.create({
  // A row being swiped rises off the sheet, as a selected one does.
  lifted: {
    backgroundColor: colorVars['--color-background-card'],
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}, 0 6px 16px -10px ${tm.shade}`,
  },
  settling: {
    transitionProperty: 'transform',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
});

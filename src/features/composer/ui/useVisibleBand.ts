import { useEffect, useState } from 'react';
import { visibleBand, type Band } from '../core/keyboard.ts';

/**
 * Where a phone's sheet can lie as the on-screen keyboard comes and goes, from the visual viewport,
 * which shrinks for the keyboard while the page it covers doesn't.
 */
export function useVisibleBand(isWanted: boolean): Band {
  const [band, setBand] = useState<Band>({ top: 0, bottom: 0 });
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!isWanted || !viewport) return;
    const follow = () => {
      const next = visibleBand(window.innerHeight, viewport);
      setBand((was) => (was.top === next.top && was.bottom === next.bottom ? was : next));
    };
    follow();
    viewport.addEventListener('resize', follow);
    viewport.addEventListener('scroll', follow);
    return () => {
      viewport.removeEventListener('resize', follow);
      viewport.removeEventListener('scroll', follow);
    };
  }, [isWanted]);
  return band;
}

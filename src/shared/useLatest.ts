import { useLayoutEffect, useRef } from 'react';

/**
 * The value of the latest render that committed, for a callback that stays the same function while
 * what it reads changes. It's written as the render commits, before the commit's passive effects.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const latest = useRef(value);
  useLayoutEffect(() => void (latest.current = value));
  return latest;
}

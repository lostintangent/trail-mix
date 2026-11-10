import { useSyncExternalStore } from 'react';

/** Whether a StyleX media constant, such as `media.phone`, matches now, kept current. */
export function useMediaQuery(atRule: string): boolean {
  const query = atRule.replace(/^@media\s+/, '');
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
  );
}

/**
 * Who listens to a store kept outside React, as `useSyncExternalStore` subscribes them, and how the
 * store tells them all that it changed.
 */
export function listeners() {
  const all = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    all.add(listener);
    return () => void all.delete(listener);
  };
  const tell = () => all.forEach((listener) => listener());
  return { subscribe, tell };
}

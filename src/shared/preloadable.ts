import { lazy, type ComponentType } from 'react';

/**
 * A component that loads apart from the first screen, with a way to load it ahead of need. Once
 * loaded it comes through a thenable that settles at once, which React renders without suspending,
 * so the first time it shows doesn't wait out the pause React gives a Suspense reveal.
 */
export function preloadable<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let loaded: ComponentType<Props> | undefined;
  const preload = async () => (loaded ??= await load());
  const Component = lazy(() => {
    if (!loaded) return preload().then((component) => ({ default: component }));
    const ready = { default: loaded };
    const settled = { then: (resolve: (module: typeof ready) => void) => resolve(ready) };
    return settled as unknown as Promise<typeof ready>;
  });
  return { Component, preload };
}

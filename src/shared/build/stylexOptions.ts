import { Features } from 'lightningcss';

/**
 * The StyleX options the app builds with, shared with `astryxClasses.test.ts` so the guard compiles
 * exactly what ships.
 *
 * Astryx ships its StyleX output precompiled with StyleX's default `x` class prefix, and its CSS
 * shares the page with ours. Atomic class names hash only the property and value, so the same
 * `x…` class in our later layers would override the states Astryx attaches to that class, such as
 * a menu item's focus background. A prefix of our own keeps the two sets disjoint.
 */
export const stylexOptions = {
  devMode: 'full',
  classNamePrefix: 'tm',
  useCSSLayers: true,
  // Astryx themes already require native light-dark(), and lowering it breaks custom tokens.
  lightningcssOptions: { exclude: Features.LightDark },
} as const;

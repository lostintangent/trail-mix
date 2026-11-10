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
  useCSSLayers: {
    // Our layers come after Astryx's, so a component's `xstyle` overrides Astryx's own styles. The
    // production stylesheet gets this order from where StyleX appends its CSS. The development one
    // is a separate style element that can load first, so it declares the order itself.
    before: ['reset', 'astryx-base', 'astryx-theme'],
  },
  // Astryx themes already require native light-dark(), and lowering it breaks custom tokens.
  lightningcssOptions: { exclude: Features.LightDark },
} as const;

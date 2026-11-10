import { defineTheme } from '@astryxdesign/core/theme';
// The built neutral theme compiles to the same CSS as its source, and the generated module then
// imports only the built one, without the runtime theme generator.
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

/**
 * The Trail Mix theme: paper and ink over the neutral theme, every color a light and dark pair.
 *
 * `bun run theme` compiles it with `astryx theme build` into `built/`, and the app loads only that
 * output: `built/trail-mix.css` and `built/trail-mix.js`. A test fails when the output is stale.
 */

const pair = (light: string, dark: string) => `light-dark(${light}, ${dark})`;

// Two hues carry the identity: warm paper (85) and blue-black ink (265).
const desk = pair('oklch(0.94 0.008 85)', 'oklch(0.165 0.02 265)'); // behind everything
const pane = pair('oklch(0.985 0.004 85)', 'oklch(0.21 0.022 265)'); // list, reader, menus
const paper = pair('#ffffff', 'oklch(0.25 0.024 265)'); // a message, the composer, a lifted row
const blue = pair('oklch(0.5 0.19 265)', 'oklch(0.77 0.13 265)'); // ink blue, the only accent

export const trailMix = defineTheme({
  name: 'trail-mix',
  extends: neutralTheme,
  typography: {
    scale: { base: 14, ratio: 1.2 },
    body: {
      family: 'ui-sans-serif',
      fallbacks: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    },
    code: { family: 'ui-monospace', fallbacks: '"SF Mono", Menlo, Consolas, monospace' },
  },
  motion: { fast: 125, medium: 300, slow: 600, ratio: 0.75 },
  tokens: {
    '--color-background-body': desk,
    '--color-background-muted': desk,
    '--color-background-surface': pane,
    '--color-background-popover': pane,
    '--color-background-card': paper,
    '--color-text-primary': pair('oklch(0.22 0.02 265)', 'oklch(0.93 0.01 85)'), // ink
    '--color-text-secondary': pair('oklch(0.42 0.02 265)', 'oklch(0.78 0.015 265)'), // read mail, labels
    '--color-text-disabled': pair('oklch(0.68 0.012 265)', 'oklch(0.5 0.02 265)'), // disabled controls only
    '--color-border': pair('oklch(0.22 0.02 265 / 0.1)', 'oklch(0.93 0.01 85 / 0.1)'),
    '--color-accent': blue,
    '--color-text-accent': blue,
    '--color-on-accent': pair('#ffffff', 'oklch(0.165 0.02 265)'),
    // Tags, avatars, the active filter.
    '--color-accent-muted': pair('oklch(0.5 0.19 265 / 0.09)', 'oklch(0.77 0.13 265 / 0.14)'),
  },
  components: {
    // Selection lifts instead of tinting: the current view rises from the desk onto a pane.
    'side-nav-item': {
      base: { color: 'var(--color-text-secondary)' },
      selected: {
        color: 'var(--color-text-primary)',
        backgroundColor: 'var(--color-background-surface)',
        boxShadow: '0 0 0 1px var(--color-border)',
        fontWeight: 'var(--font-weight-semibold)',
      },
    },
  },
  adaptations: {
    // Pointer picks the size: under a finger, at any width, every control is at least 44px.
    rules: [
      {
        when: { pointer: 'coarse' },
        value: {
          tokens: {
            '--size-element-sm': '44px',
            '--size-element-md': '44px',
            '--size-element-lg': '44px',
          },
        },
      },
    ],
  },
});

import { defineTheme } from '@astryxdesign/core/theme';
// The built neutral theme compiles to the same CSS as its source, and the generated module then
// imports only the built one, without the runtime theme generator.
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { DEFAULT_ACCENT, DESK, MUTED_ALPHA, PANE, PAPER, type Halves } from './palette.ts';

/**
 * The Trail Mix theme: paper and ink over the neutral theme, every color a light and dark pair.
 *
 * `bun run theme` compiles it with `astryx theme build` into `built/`, and the app loads only that
 * output: `built/trail-mix.css` and `built/trail-mix.js`. A test fails when the output is stale.
 */

const pair = (light: string, dark: string) => `light-dark(${light}, ${dark})`;
const paired = ({ light, dark }: Halves) => pair(light, dark);

const desk = paired(DESK);
const pane = paired(PANE);
const paper = paired(PAPER);
// The accent until the member picks another, which then replaces it before first paint.
const accent = paired(DEFAULT_ACCENT);
// Ink in three strengths: what is read, what supports it, and what is quiet.
const ink2 = pair('oklch(0.42 0.02 265)', 'oklch(0.78 0 0)');
const ink3 = pair('oklch(0.52 0.015 265)', 'oklch(0.66 0 0)');
const inkDisabled = pair('oklch(0.68 0.012 265)', 'oklch(0.5 0 0)');

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
    '--color-text-primary': pair('oklch(0.22 0.02 265)', 'oklch(0.93 0 0)'), // ink
    '--color-text-secondary': ink2, // read mail, labels
    '--color-text-disabled': inkDisabled, // disabled controls only
    // A control's icon is its label, so it is ink: 7:1 or more on every surface, and a quiet icon
    // at least 4.6:1. Ink, not the neutral theme's gray, in both themes.
    '--color-icon-primary': ink2,
    '--color-icon-secondary': ink3,
    '--color-icon-disabled': inkDisabled,
    '--color-icon-accent': accent,
    '--color-border': pair('oklch(0.22 0.02 265 / 0.1)', 'oklch(0.93 0 0 / 0.1)'),
    // A control's edge, such as a field's, where its fill doesn't set it apart: 3:1 or more against
    // its fill and what's around it, on the desk, a pane or paper.
    '--color-border-emphasized': pair('oklch(0.22 0.02 265 / 0.55)', 'oklch(0.93 0 0 / 0.42)'),
    '--color-accent': accent,
    '--color-text-accent': accent,
    '--color-on-accent': pair('#ffffff', 'oklch(0.165 0 0)'),
    // Tags, avatars, the active filter.
    '--color-accent-muted': pair(
      DEFAULT_ACCENT.light.replace(')', ` / ${MUTED_ALPHA.light})`),
      DEFAULT_ACCENT.dark.replace(')', ` / ${MUTED_ALPHA.dark})`),
    ),
  },
  components: {
    // A quiet control, such as a toolbar's icon, is drawn in the supporting ink, not the ink read.
    button: { 'variant:ghost': { color: 'var(--color-text-secondary)' } },
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

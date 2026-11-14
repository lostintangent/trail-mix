import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { loadedAlongside } from './chunks.ts';

const DIST = '/@astryxdesign/core/dist/';
const BUTTON = `${DIST}Button/Button.js`;
const SOURCE = '../Tooltip/useTooltip.js';
const HOOK = 'useTooltip';
/** What the later hook gives `Button`, so the build fails if `Button` reads anything else. */
const READ = new Set(['ref', 'describedBy', 'renderTooltip']);
/** Astryx's tooltip code and the layer it opens, which the first screen does without. */
const LATER = [`${DIST}Tooltip/useTooltip.js`, `${DIST}Layer/useLayer.js`];
/** The app's hook, which loads the real one once the first screen has settled. */
const LATER_TOOLTIP = fileURLToPath(new URL('../LaterTooltip.tsx', import.meta.url));

/**
 * Every Astryx `Button` calls Astryx's `useTooltip`, tooltip or none, so the tooltip's code and the
 * layer it opens, about 15 KB gzip, come to the first screen with its first button, though no
 * tooltip shows until a hover or a focus rests. This gives `Button` the app's `useLaterTooltip` in
 * its place, which loads the real hook once the first screen has settled, or as soon as a pointer
 * or focus reaches a button, and runs it for each button from then on.
 *
 * The build fails if `Button.js` changes so the swap can't be made, if `Button` reads more of the
 * hook than the later hook gives, or if the chunk that holds `Button` loads the tooltip's code
 * anyway.
 */
export function astryxButtonTooltip(): Plugin {
  return {
    name: 'astryx-button-tooltip',
    apply: 'build',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    transform(code, id) {
      if (!id.endsWith(BUTTON)) return null;
      return { code: laterButtonTooltip(code, LATER_TOOLTIP), map: null };
    },
    generateBundle(_, bundle) {
      for (const { end, fileName } of loadedAlongside(bundle, BUTTON, LATER)) {
        this.error(
          `Astryx's ${end.slice(DIST.length)} is in ${fileName}, which loads with Button.js, so ` +
            'the tooltip is back on the first load.',
        );
      }
    },
  };
}

/**
 * Astryx's `Button.js`, importing its tooltip hook from `from` rather than from Astryx. Throws if
 * it no longer imports `useTooltip` alone and keeps one call's result under one name, or reads
 * more of that result than `READ` holds. It reads the file by pattern, so a change it can't vouch
 * for stops the build even when it's harmless.
 */
export function laterButtonTooltip(code: string, from: string): string {
  const statement = `import { ${HOOK} } from ${JSON.stringify(SOURCE)};`;
  if (code.split(SOURCE).length !== 2 || !code.includes(statement)) {
    throw new Error(`Astryx's Button.js no longer imports ${HOOK} alone from ${SOURCE}.`);
  }
  const calls = [...code.matchAll(new RegExp(`\\bconst (\\w+) = ${HOOK}\\(`, 'g'))];
  const [call] = calls;
  if (calls.length !== 1 || !call) {
    throw new Error(`Astryx's Button no longer keeps what one call of ${HOOK} returns.`);
  }
  const declared = call.index + 'const '.length;
  for (const read of code.matchAll(new RegExp(`\\b${call[1]}\\b(?:\\.(\\w+))?`, 'g'))) {
    if (read.index === declared || READ.has(read[1] ?? '')) continue;
    const line = code.slice(code.lastIndexOf('\n', read.index) + 1, code.indexOf('\n', read.index));
    throw new Error(
      `Astryx's Button reads ${line.trim()}, which the later ${HOOK} doesn't give it.`,
    );
  }
  return code.replace(
    statement,
    `import { useLaterTooltip as ${HOOK} } from ${JSON.stringify(from)};`,
  );
}

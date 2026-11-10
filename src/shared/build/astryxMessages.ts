import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { isSimpleMessage } from './messageFormat.ts';

const I18N = '/@astryxdesign/core/dist/i18n/';
const ENGLISH = `${I18N}generated-english/`;
const MESSAGE = /"(@astryx\.[\w.]+)":\s*("(?:[^"\\]|\\.)*")/g;
const FORMATTER = fileURLToPath(new URL('./messageFormat.ts', import.meta.url));

/**
 * Astryx formats every message it shows through `intl-messageformat` and its ICU parser, about
 * 30 KiB gzip on the first load, though the English it ships for the components we use needs only
 * `{name}` and `{name, number}`. This swaps in a formatter sized to them. Each bundled component's
 * English arrives in its own generated module, and the build fails if one of those messages needs
 * plural, select or any other ICU syntax the lean formatter lacks.
 */
export function astryxMessages(): Plugin {
  return {
    name: 'astryx-messages',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      return source === 'intl-messageformat' && importer?.includes(I18N) ? FORMATTER : null;
    },
    transform(code, id) {
      if (!id.includes(ENGLISH)) return null;
      for (const [, key = '', literal = '""'] of code.matchAll(MESSAGE)) {
        const message = JSON.parse(literal) as string;
        if (!isSimpleMessage(message)) {
          this.error(`${key} needs ICU features the lean formatter lacks: "${message}"`);
        }
      }
      return null;
    },
  };
}

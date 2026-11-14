import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { astryxMessages } from './astryxMessages.ts';

// If Astryx changed the shape of its generated English, the guard would find no messages and pass
// everything, so this runs it over a real component's.
test('the guard stops the build on a message that needs more than the lean formatter, as Pagination has', () => {
  const folder = fileURLToPath(
    new URL(
      '../../../node_modules/@astryxdesign/core/dist/i18n/generated-english/Pagination/',
      import.meta.url,
    ),
  );
  const errors: string[] = [];
  const transform = astryxMessages().transform as (
    this: { error: (message: string) => void },
    code: string,
    id: string,
  ) => void;
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.generated.js'))) {
    const id = `${folder}${file}`;
    transform.call({ error: (message) => errors.push(message) }, readFileSync(id, 'utf8'), id);
  }
  expect(errors.some((error) => error.startsWith('@astryx.pagination.'))).toBe(true);
});

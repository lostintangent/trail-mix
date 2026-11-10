import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { isSimpleMessage } from './messageFormat.ts';

const ENGLISH = new URL(
  '../../../node_modules/@astryxdesign/core/dist/i18n/generated-english/',
  import.meta.url,
);

/** Every message of one component's generated English module, by key. */
function messagesOf(component: string): Record<string, string> {
  const folder = new URL(`${component}/`, ENGLISH);
  const found: Record<string, string> = {};
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.generated.js'))) {
    const code = readFileSync(new URL(file, folder), 'utf8');
    for (const [, key = '', literal = '""'] of code.matchAll(
      /"(@astryx\.[\w.]+)":\s*("(?:[^"\\]|\\.)*")/g,
    )) {
      found[key] = JSON.parse(literal) as string;
    }
  }
  return found;
}

// The build's guard reads each generated module with the same pattern. If Astryx changed their
// shape, the guard would find no messages and pass everything, so this reads a real one.
test('the guard finds the messages that need more than the lean formatter, as Pagination has', () => {
  const pagination = Object.values(messagesOf('Pagination'));
  expect(pagination.length).toBeGreaterThan(0);
  expect(pagination.some((message) => !isSimpleMessage(message))).toBe(true);
});

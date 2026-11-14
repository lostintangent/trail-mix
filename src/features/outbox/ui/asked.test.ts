import { afterAll, expect, test } from 'bun:test';
import { fail, pressed, type Press } from './asked.ts';

// The page a press holds open, which asks before closing while the press is on its way.
const page = Object.assign(globalThis, { window: new EventTarget() }).window;
afterAll(() => Reflect.deleteProperty(globalThis, 'window'));
const isHeld = () => !page.dispatchEvent(new Event('beforeunload', { cancelable: true }));

test('a hand-off that fails gives its message back, with why, and lets the page close', () => {
  const reasons: string[] = [];
  const press = { id: 'press', onFailed: (reason: string) => void reasons.push(reason) } as Press;
  pressed(press, () => {});
  expect(isHeld()).toBe(true);
  fail(press, new Error('The sending module failed to load'));
  expect(reasons).toEqual(['The sending module failed to load.']);
  expect(isHeld()).toBe(false);
});

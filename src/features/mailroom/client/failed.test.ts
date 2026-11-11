import { expect, test } from 'bun:test';
import { whatFailed } from './failed.ts';

test('a failed call says the status the Worker answered with, and its reason', () => {
  const reset = Object.assign(new Error('Durable Object reset because its code was updated.'), {
    status: 500,
  });
  expect(whatFailed(reset)).toBe(
    'Trail Mix answered 500: Durable Object reset because its code was updated.',
  );
  expect(whatFailed(Object.assign(new Error(''), { status: 401 }))).toBe('Trail Mix answered 401.');
});

test('a call no answer came back to says so, with the browser’s reason', () => {
  expect(whatFailed(new TypeError('Failed to fetch'), false)).toBe(
    'No answer came: Failed to fetch',
  );
  expect(whatFailed(undefined, false)).toBe('No answer came.');
});

test('a call no answer came back to while the browser says it’s offline says the device is', () => {
  expect(whatFailed(new TypeError('Load failed'), true)).toBe('This device is offline.');
  // An answer came, so its status and reason say more.
  const answered = Object.assign(new Error('Service Unavailable'), { status: 503 });
  expect(whatFailed(answered, true)).toBe('Trail Mix answered 503: Service Unavailable');
});

test('an error page is cut down to the start of its words', () => {
  const page = `<!doctype html><html><head><title>Worker threw exception</title></head><body><h1>Error 1101</h1><p>${'x '.repeat(200)}</p></body></html>`;
  const said = whatFailed(Object.assign(new Error(page), { status: 500 }));
  expect(said).toStartWith('Trail Mix answered 500: Worker threw exception Error 1101 x x');
  expect(said).not.toContain('<');
  expect(said.length).toBeLessThanOrEqual('Trail Mix answered 500: '.length + 160);
});

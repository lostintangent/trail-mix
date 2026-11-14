import { expect, test } from 'bun:test';
import { isRefusal, whatFailed } from './failed.ts';

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

test('a failed call was refused when the Mailroom or the Worker answered it so', () => {
  // The server function answers the Mailroom's refusal 200, with the error it threw.
  expect(isRefusal({ status: 200 }, new Error('There is no such send.'))).toBe(true);
  // The Worker turned it away, as a command from another origin.
  expect(isRefusal({ status: 403 }, new Error('Forbidden'))).toBe(true);
});

test('a failed call that may not have run, or whose answer was lost, is no refusal', () => {
  // No answer came at all.
  expect(isRefusal(undefined, new TypeError('Load failed'))).toBe(false);
  // An answer came, but its body never came whole.
  expect(isRefusal({ status: 200 }, new TypeError('network error'))).toBe(false);
  expect(isRefusal({ status: 200 }, new SyntaxError('Unexpected end of JSON input'))).toBe(false);
  // Cloudflare failed it, as when a deploy restarts the Mailroom, or a platform's page answered.
  expect(isRefusal({ status: 503 }, new Error('Network connection lost.'))).toBe(false);
  expect(isRefusal({ status: 502 }, new Error('<html>Bad gateway</html>'))).toBe(false);
  // The demo's limit on changes, which asks to be asked again later.
  expect(isRefusal({ status: 429 }, new Error('Too many changes for now.'))).toBe(false);
});

import { expect, test } from 'bun:test';
import { withoutBcc } from './send.ts';

test('a message loses its Bcc field, folded lines too, and keeps every other byte', () => {
  const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const message = bytes(
    'From: me@trailmix.test\nBCC: hidden@trailmix.test,\r\n\tother@trailmix.test\r\n' +
      'To: you@trailmix.test\r\n\r\nBcc: stays in the body\r\n\x85\x9f\xff',
  );
  expect(withoutBcc(message)).toEqual(
    bytes(
      'From: me@trailmix.test\nTo: you@trailmix.test\r\n\r\nBcc: stays in the body\r\n\x85\x9f\xff',
    ),
  );
});

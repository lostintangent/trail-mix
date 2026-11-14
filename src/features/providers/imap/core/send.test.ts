import { expect, test } from 'bun:test';
import { submitFailure, withoutBcc } from './send.ts';

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

test('an SMTP 4xx is a passing failure, even after the body went out, since the host kept nothing', () => {
  for (const bodySent of [false, true]) {
    const failure = { responseCode: 451, response: '451 4.3.0 Try again later' };
    expect(submitFailure(failure, bodySent, 'smtp.example.com')).toEqual({
      error: 'smtp.example.com can’t take it right now: 451 4.3.0 Try again later',
      passing: true,
    });
  }
});

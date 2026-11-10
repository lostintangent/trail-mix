import { describe, expect, test } from 'bun:test';
import {
  envelopeOf,
  hasAttachments,
  previewOf,
  previewPartOf,
  type Structure,
} from './envelope.ts';

const text = (part: string, extra: Partial<Structure> = {}): Structure => ({
  part,
  type: 'text/plain',
  ...extra,
});
const html = (part: string): Structure => ({ part, type: 'text/html' });
const multipart = (type: string, ...childNodes: Structure[]): Structure => ({
  type: `multipart/${type}`,
  childNodes,
});

describe('the preview part', () => {
  test('is the plain text of an alternative, not its HTML', () => {
    expect(previewPartOf(multipart('alternative', html('1'), text('2')))?.part).toBe('2');
  });

  test('is the HTML when there is no plain text', () => {
    expect(
      previewPartOf(
        multipart('related', html('1'), { part: '2', type: 'image/png', id: '<logo>' }),
      ),
    ).toEqual({
      part: '1',
      html: true,
    });
  });

  test('is the text of a message that is a single part, which IMAP calls TEXT', () => {
    expect(
      previewPartOf({
        type: 'text/plain',
        parameters: { charset: 'iso-8859-1' },
        encoding: 'quoted-printable',
      }),
    ).toEqual({
      part: 'TEXT',
      html: false,
      charset: 'iso-8859-1',
      encoding: 'quoted-printable',
    });
  });

  test('is never a text file someone attached', () => {
    const attached = text('2', { disposition: 'attachment' });
    expect(previewPartOf(multipart('mixed', html('1'), attached))?.part).toBe('1');
    expect(previewPartOf(multipart('mixed', attached))).toBeUndefined();
  });
});

describe('attachments', () => {
  test('are parts marked as attachments, and files of any other type', () => {
    expect(
      hasAttachments(multipart('mixed', text('1'), { part: '2', type: 'application/pdf' })),
    ).toBe(true);
    expect(
      hasAttachments(multipart('mixed', text('1'), text('2', { disposition: 'attachment' }))),
    ).toBe(true);
    expect(hasAttachments({ part: '2', type: 'message/rfc822', childNodes: [text('2.1')] })).toBe(
      true,
    );
  });

  test('are not the images HTML shows inline, nor the alternatives of one text', () => {
    const inline = { part: '2', type: 'image/png', id: '<logo@example.com>' };
    expect(hasAttachments(multipart('related', html('1'), inline))).toBe(false);
    expect(hasAttachments(multipart('alternative', text('1'), html('2')))).toBe(false);
  });
});

describe('the preview', () => {
  test('leaves out quoted lines and folds whitespace', () => {
    expect(
      previewOf('Sounds good.\r\n\r\nOn Monday, Ada wrote:\r\n> Lunch?\r\n>   Friday', false),
    ).toBe('Sounds good. On Monday, Ada wrote:');
  });

  test('reads HTML as text: no head, styles, scripts or quotes, and entities decoded', () => {
    const page =
      '<html><head><title>Hi</title><style>p{color:red}</style></head><body>' +
      '<p>Fish &amp; chips&nbsp;at&#32;noon&#x21;</p><blockquote>old reply</blockquote><script>x()</script>' +
      '<p>See you</p></body></html>';
    expect(previewOf(page, true)).toBe('Fish & chips at noon! See you');
  });

  test('stops at 200 characters', () => {
    expect(previewOf('word '.repeat(100), false)).toHaveLength(200);
  });

  test('keeps a markup character that starts no tag', () => {
    expect(previewOf('<p>2 &lt; 3 and 3 > 2</p>', true)).toBe('2 < 3 and 3 > 2');
  });
});

describe('an envelope', () => {
  const ref = { account: 'a', path: 'INBOX', uidValidity: 7, uid: 42 };
  const flags = { seen: true, flagged: false, answered: false, draft: false };

  test('takes its ids, list and addresses from what IMAP reports', () => {
    const envelope = envelopeOf({
      ref,
      flags,
      envelope: {
        date: '2026-11-09T12:00:00Z',
        subject: 'Re: Plans',
        messageId: '<b@example.com>',
        inReplyTo: '<a@example.com>',
        from: [{ name: 'Ada Park', address: 'ada@example.com' }],
        to: [{ address: 'me@trailmix.test' }, { name: 'Undisclosed recipients' }],
      },
      headers:
        'References: <root@example.com>\r\n <a@example.com>\r\nList-Id: Plans <plans.example.com>\r\nList-Unsubscribe: <mailto:leave@example.com>\r\n',
      previewText: 'Yes.',
    });
    expect(envelope).toEqual({
      ...ref,
      messageId: '<b@example.com>',
      references: ['<root@example.com>', '<a@example.com>'],
      from: { name: 'Ada Park', email: 'ada@example.com' },
      to: [{ email: 'me@trailmix.test' }],
      cc: [],
      subject: 'Re: Plans',
      date: '2026-11-09T12:00:00.000Z',
      preview: 'Yes.',
      flags,
      hasAttachments: false,
      list: { id: 'plans.example.com', unsubscribe: '<mailto:leave@example.com>' },
    });
  });

  test('falls back to the arrival date, and has no list without a List-Id', () => {
    const envelope = envelopeOf({
      ref,
      flags,
      envelope: {},
      headers: '',
      internalDate: '2026-11-08T08:00:00Z',
      previewText: '',
    });
    expect(envelope.date).toBe('2026-11-08T08:00:00.000Z');
    expect(envelope.from).toEqual({ email: '' });
    expect(envelope).not.toHaveProperty('list');
  });
});

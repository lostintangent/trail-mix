import { describe, expect, test } from 'bun:test';
import { envelopeOf, hasAttachments, previewPartsOf, type Structure } from './envelope.ts';

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

describe('the preview parts', () => {
  test('are the plain text and the HTML of an alternative', () => {
    expect(previewPartsOf(multipart('alternative', html('1'), text('2')))).toEqual({
      plain: { part: '2' },
      html: { part: '1' },
    });
  });

  test('are the HTML alone when there is no plain text', () => {
    expect(
      previewPartsOf(
        multipart('related', html('1'), { part: '2', type: 'image/png', id: '<logo>' }),
      ),
    ).toEqual({ html: { part: '1' } });
  });

  test('are the text of a message that is a single part, which IMAP calls TEXT', () => {
    expect(
      previewPartsOf({
        type: 'text/plain',
        parameters: { charset: 'iso-8859-1' },
        encoding: 'quoted-printable',
      }),
    ).toEqual({
      plain: { part: 'TEXT', charset: 'iso-8859-1', encoding: 'quoted-printable' },
    });
  });

  test('are never a text file someone attached', () => {
    const attached = text('2', { disposition: 'attachment' });
    expect(previewPartsOf(multipart('mixed', html('1'), attached))).toEqual({
      html: { part: '1' },
    });
    expect(previewPartsOf(multipart('mixed', attached))).toEqual({});
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
      previews: { plain: 'Yes.' },
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
      verified: false,
    });
  });

  test('is verified when the account’s server, writing on top, found DMARC passing for its From', () => {
    const vouched = {
      ref,
      flags,
      envelope: { from: [{ name: 'Kernel Weekly', address: 'hello@kernelweekly.example.com' }] },
      headers:
        'Authentication-Results: mx.zohomail.com; dmarc=pass header.from=kernelweekly.example.com\r\nReferences: <a@example.com>\r\n',
      previews: {},
    };
    expect(envelopeOf(vouched, ['mx.zohomail.com']).verified).toBe(true);
    // An account whose preset names no server vouches for nobody.
    expect(envelopeOf(vouched).verified).toBe(false);
  });

  test('falls back to the arrival date, and has no list without a List-Id', () => {
    const envelope = envelopeOf({
      ref,
      flags,
      envelope: {},
      headers: '',
      internalDate: '2026-11-08T08:00:00Z',
      previews: {},
    });
    expect(envelope.date).toBe('2026-11-08T08:00:00.000Z');
    expect(envelope.from).toEqual({ email: '' });
    expect(envelope).not.toHaveProperty('list');
  });
});

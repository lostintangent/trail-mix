import { expect, test } from 'bun:test';
import PostalMime, { type Address as ParsedAddress } from 'postal-mime';
import { seededRandom } from '../../../shared/random.ts';
import { writeMime, type MimeAttachment, type MimeMessage } from './mime.ts';
import type { Address } from './model.ts';

const message: MimeMessage = {
  date: '2026-11-09T12:00:00.000Z',
  messageId: '<plan.2@example.com>',
  from: { name: 'Ada Park', email: 'ada@example.com' },
  to: [{ name: 'Sam Rivera', email: 'me@trailmix.test' }],
  subject: 'Re: Workers migration plan',
  references: ['<plan.0@trailmix.test>', '<plan.1@example.com>'],
  text: 'The Durable Object approach looks right.',
  boundary: 'plan',
};

const picture: MimeAttachment = {
  name: 'ridge.png',
  type: 'image/png',
  content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  contentId: 'ridge@example.com',
};

const invoice: MimeAttachment = {
  name: 'INV-2071.pdf',
  type: 'application/pdf',
  content: new TextEncoder().encode('%PDF-1.4\n'),
};

test('a message reads back exactly as it was written', async () => {
  const written = { ...message, html: '<p>Looks right.</p>', attachments: [picture, invoice] };

  expect(await readBack(written)).toEqual(expected(written));
});

test('inline images travel with the HTML, and other files are attached after it', async () => {
  const parsed = await PostalMime.parse(
    writeMime({
      ...message,
      html: '<img src="cid:ridge@example.com">',
      attachments: [picture, invoice],
    }),
  );

  expect(
    parsed.attachments.map(({ filename, disposition, related }) => [
      filename,
      disposition,
      related,
    ]),
  ).toEqual([
    ['ridge.png', 'inline', true],
    ['INV-2071.pdf', 'attachment', undefined],
  ]);
});

test('only an image the HTML can show goes inline, so nothing else is taken for the body', async () => {
  const notes = {
    name: 'notes.txt',
    type: 'text/plain',
    content: new Uint8Array([120]),
    contentId: 'n',
  };
  const withoutHtml = await PostalMime.parse(writeMime({ ...message, attachments: [picture] }));
  const withHtml = await PostalMime.parse(
    writeMime({ ...message, html: '<p>Hi</p>', attachments: [notes] }),
  );

  for (const parsed of [withoutHtml, withHtml]) {
    expect(parsed.attachments.map(({ disposition }) => disposition)).toEqual(['attachment']);
    expect(parsed.text).toBe(message.text);
  }
});

test('the same message always gives the same bytes, and its boundary is the only thing that varies them', () => {
  const written = { ...message, html: '<p>Hi</p>', attachments: [picture] };

  expect(writeMime(written)).toBe(writeMime({ ...written }));
  expect(writeMime({ ...written, boundary: 'other' })).not.toBe(writeMime(written));
});

test('a draft keeps its Bcc, and a message with no recipients yet is still a message', async () => {
  const draft = { ...message, to: [], bcc: [{ email: 'jonas@example.com' }] };

  const parsed = await PostalMime.parse(writeMime(draft));

  expect(parsed.to).toBeUndefined();
  expect(parsed.bcc).toEqual([{ name: '', address: 'jonas@example.com' }]);
});

test('short plain ASCII is written as it is, and anything a transport could change is encoded', () => {
  const plain = writeMime(message);
  const encoded = writeMime({ ...message, text: 'Two notes = one plan \nüber' });

  expect(plain).toContain(
    'Content-Transfer-Encoding: 7bit\r\n\r\nThe Durable Object approach looks right.',
  );
  expect(encoded).toContain('Two notes =3D one plan=20\r\n=C3=BCber');
});

test('what cannot be written is refused, rather than written wrong', () => {
  const refused = [
    { ...message, boundary: 'two words' },
    { ...message, boundary: '' },
    { ...message, from: { email: 'ada park@example.com' } },
    { ...message, to: [{ email: 'ada@example.com>, eve@example.com' }] },
    { ...message, messageId: 'plan@example.com' },
    { ...message, references: ['<a@x> <b@x>'] },
    { ...message, headers: [['List-Id', 'Wöchentlich <weekly.example.com>']] },
    { ...message, headers: [['X-Injected: yes\r\nBcc', 'eve@example.com']] },
    { ...message, date: 'Monday' },
  ] satisfies MimeMessage[];

  for (const written of refused) expect(() => writeMime(written)).toThrow();
});

// Properties over generated messages full of what breaks mail: every script, emoji, long words and
// lines, `=`, trailing spaces, bare CR and LF, header syntax in names, and lines that look like
// the message's own boundaries.

const SEEDS = Array.from({ length: 150 }, (_, seed) => seed + 1);

test('whatever goes in reads back exactly', async () => {
  for (const seed of SEEDS) {
    const written = generated(seededRandom(seed));

    expect(await readBack(written)).toEqual(expected(written));
  }
});

test('whatever goes in, what comes out survives any transport: 7-bit, CRLF, and short clean lines', () => {
  for (const seed of SEEDS) {
    const raw = writeMime(generated(seededRandom(seed)));
    const lines = raw.split('\r\n');

    expect([...raw].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    expect(lines.filter((line) => /[\r\n]/.test(line))).toEqual([]);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(998);
    // Some servers strip whitespace at the end of a line.
    expect(lines.filter((line) => /[ \t]$/.test(line))).toEqual([]);
    expect(raw.match(/=\?UTF-8\?B\?[^?]*\?=/g)?.filter((word) => word.length > 75) ?? []).toEqual(
      [],
    );
    // Folding keeps headers to 78 characters wherever a token allows it.
    const headers = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
    expect(headers.filter((line) => line.length > 78 && / \S+ /.test(line.trim()))).toEqual([]);
  }
});

/** What postal-mime reads from the written message, in the writer's own terms. */
async function readBack(written: MimeMessage) {
  const parsed = await PostalMime.parse(writeMime(written));
  const address = (mailbox: ParsedAddress | undefined): Address => ({
    ...(mailbox?.name ? { name: mailbox.name } : {}),
    email: mailbox?.address ?? '',
  });
  return {
    date: parsed.date,
    messageId: parsed.messageId,
    from: address(parsed.from),
    to: (parsed.to ?? []).map(address),
    cc: (parsed.cc ?? []).map(address),
    subject: parsed.subject,
    references: parsed.references?.split(/\s+/) ?? [],
    inReplyTo: parsed.inReplyTo,
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments.map((file) => ({
      name: file.filename ?? '',
      type: file.mimeType,
      content: new Uint8Array(file.content as ArrayBuffer),
      contentId: file.contentId?.slice(1, -1),
    })),
  };
}

/**
 * What `readBack` should find. Line endings come back as LF, as every parser gives them, and an
 * empty body reads as none. A body that is the whole message ends where the message does, and the
 * last line of a message always ends with a line break.
 */
function expected(written: MimeMessage) {
  const whole =
    !written.attachments?.length && (written.text === undefined || written.html === undefined);
  const lines = (text: string | undefined) => {
    const body = text?.replace(/\r\n?/g, '\n') || undefined;
    return whole && body && !body.endsWith('\n') ? `${body}\n` : body;
  };
  const references = written.references ?? [];
  return {
    date: written.date,
    messageId: written.messageId,
    from: written.from,
    to: written.to,
    cc: written.cc ?? [],
    subject: written.subject,
    references,
    inReplyTo: references.at(-1),
    text: lines(written.text),
    html: lines(written.html),
    // Inline images come first, with the HTML, and the attached files after.
    attachments: (written.attachments ?? [])
      .map((file) => ({
        ...file,
        content: new Uint8Array(file.content),
        contentId: written.html && file.type.startsWith('image/') ? file.contentId : undefined,
      }))
      .sort((a, b) => Number(!a.contentId) - Number(!b.contentId)),
  };
}

function generated(random: () => number): MimeMessage {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const some = <T>(make: () => T, most: number) =>
    Array.from({ length: Math.floor(random() * (most + 1)) }, make);
  const boundary = `b${Math.floor(random() * 1e6)}`;

  const pieces = [
    'mail',
    'Grüße',
    'Köln',
    '東京',
    'привет',
    'مرحبا',
    '🌧️',
    '👩🏽‍💻',
    'a=b',
    '=?UTF-8?B?eA==?=',
    '"quoted"',
    "O'Brien,",
    '<tag>',
    '\\',
    'x'.repeat(120),
    '  ',
    '\t',
    `--=_${boundary}_0`,
  ];
  const words = (most: number) => some(() => pick(pieces), most).join(pick([' ', '', '  ']));
  const line = () => words(12);
  const text = () => some(line, 6).join(pick(['\n', '\r\n', '\r']));
  const name = () => (random() < 0.3 ? undefined : words(4).trim().replace(/\s+/g, ' ') || 'Ada');
  const address = (): Address => {
    const person = name();
    return {
      ...(person ? { name: person } : {}),
      email: `${pick(['ada', 'o.brien', 'x+y'])}@example.com`,
    };
  };
  // Readers decode encoded words even inside RFC 2231 file names, so a name that is itself one
  // cannot read back as written. Every other name can.
  const file = (i: number): MimeAttachment => ({
    name: words(3).replaceAll('=?', '?') || 'file',
    type: pick(['image/png', 'application/pdf', 'text/plain']),
    content: Uint8Array.from(some(() => Math.floor(random() * 256), 300)),
    ...(random() < 0.4 ? { contentId: `part${i}@example.com` } : {}),
  });

  return {
    date: new Date(Date.UTC(2026, 10, 9) - Math.floor(random() * 4e7) * 1000).toISOString(),
    messageId: `<${boundary}@example.com>`,
    from: address(),
    to: some(address, 3),
    cc: some(address, 2),
    subject: words(10).trim().replace(/\s+/g, ' '),
    references: some(() => `<${Math.floor(random() * 1e9)}@example.com>`, 20),
    ...(random() < 0.8 ? { text: text() } : {}),
    ...(random() < 0.6 ? { html: `<p>${text()}</p>` } : {}),
    attachments: some(() => file(Math.floor(random() * 1e6)), 3),
    boundary,
  };
}

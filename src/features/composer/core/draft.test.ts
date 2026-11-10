import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { writeMime, type Address, type MimeAttachment } from '../../mail/core/index.ts';
import {
  contentIdFor,
  messageOf,
  replyRecipients,
  replySubject,
  withSignature,
  type Draft,
} from './draft.ts';
import { renderMarkdown } from './markdown.ts';

const me: Address = { name: 'Ada Lovelace', email: 'ada@example.com' };
const grace: Address = { name: 'Grace Hopper', email: 'grace@example.com' };
const alan: Address = { name: 'Alan Turing', email: 'alan@example.org' };
const edsger: Address = { email: 'edsger@example.net' };

const copy = {
  date: '2026-11-10T09:30:00.000Z',
  messageId: '<draft-1@trailmix.invalid>',
  boundary: 'composer-test',
};

const draft: Draft = {
  from: me,
  to: [grace],
  cc: [alan],
  bcc: [edsger],
  subject: 'The engine',
  markdown: 'The **analytical** engine weaves *algebraic* patterns.\n\n- cards\n- gears',
  attachments: [],
};

const ridge = contentIdFor('6f1c2b8e-0d4b-4c38-9d8e-3f0a1b2c3d4e');
const photo: MimeAttachment = {
  name: 'ridge.png',
  type: 'image/png',
  content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  contentId: ridge,
};
const notes: MimeAttachment = {
  name: 'notes.pdf',
  type: 'application/pdf',
  content: new TextEncoder().encode('%PDF-1.7'),
};

async function sent(written: Draft) {
  const raw = writeMime(messageOf(written, copy));
  return { raw, parsed: await PostalMime.parse(raw) };
}

test('a message is its Markdown twice: rendered as the HTML part, and as written as the plain text', async () => {
  const { parsed } = await sent(draft);
  expect(parsed.text).toBe(draft.markdown);
  expect(parsed.html).toBe(renderMarkdown(draft.markdown));
  expect(parsed.from).toEqual({ name: me.name!, address: me.email });
  expect(parsed.to).toEqual([{ name: grace.name!, address: grace.email }]);
  expect(parsed.cc).toEqual([{ name: alan.name!, address: alan.email }]);
  expect(parsed.bcc).toEqual([{ name: '', address: edsger.email }]);
  expect(parsed.subject).toBe('The engine');
  expect(parsed.messageId).toBe(copy.messageId);
  expect(parsed.date).toBe(copy.date);
  expect(parsed.inReplyTo).toBeUndefined();
  expect(parsed.references).toBeUndefined();
});

test('the plain text keeps every character written, a signature delimiter included', async () => {
  const markdown = withSignature(
    '  Ça marche — à demain 🚀\n\nLine one\nline two  ',
    'Ada\n*Engines*',
  );
  const { parsed } = await sent({ ...draft, subject: 'Résumé ✓', markdown });
  expect(parsed.text).toBe(markdown);
  expect(parsed.text).toContain('\n\n-- \nAda\n*Engines*');
  expect(parsed.subject).toBe('Résumé ✓');
});

test("a reply names its parent and its parent's references, so other clients thread it", async () => {
  const parent = {
    messageId: '<parent@example.com>',
    references: ['<root@example.com>', '<middle@example.com>'],
  };
  const { parsed } = await sent({ ...draft, parent });
  expect(parsed.inReplyTo).toBe('<parent@example.com>');
  expect(parsed.references).toBe('<root@example.com> <middle@example.com> <parent@example.com>');
});

test('a reply deep in a long thread keeps its first message and its nearest ancestors', async () => {
  const ancestors = Array.from({ length: 30 }, (_, i) => `<${i}@example.com>`);
  const { parsed } = await sent({
    ...draft,
    parent: { messageId: '<30@example.com>', references: ancestors },
  });
  const references = parsed.references!.split(' ');
  expect(references).toHaveLength(20);
  expect(references[0]).toBe('<0@example.com>');
  expect(references.slice(1)).toEqual(
    Array.from({ length: 19 }, (_, i) => `<${i + 12}@example.com>`),
  );
  expect(parsed.inReplyTo).toBe('<30@example.com>');
});

test("a reply to a parent without a Message-ID threads by the parent's own references", async () => {
  const { parsed } = await sent({
    ...draft,
    parent: { messageId: '', references: ['<root@example.com>'] },
  });
  expect(parsed.references).toBe('<root@example.com>');
});

test('a pasted image travels inline with the HTML that shows it, and a file is attached', async () => {
  const markdown = `The ridge at dawn:\n\n![The ridge](cid:${ridge})\n\nNotes attached.`;
  const { raw, parsed } = await sent({ ...draft, markdown, attachments: [photo, notes] });

  expect(parsed.html).toContain(`<img src="cid:${ridge}" alt="The ridge"`);
  expect(parsed.text).toBe(markdown);
  const [image, pdf] = parsed.attachments;
  expect(image).toMatchObject({
    filename: 'ridge.png',
    disposition: 'inline',
    contentId: `<${ridge}>`,
  });
  expect([...new Uint8Array(image!.content as ArrayBuffer)]).toEqual([...photo.content]);
  expect(pdf).toMatchObject({ filename: 'notes.pdf', disposition: 'attachment' });
  expect(pdf!.contentId).toBeUndefined();

  const structure = [...raw.matchAll(/^Content-Type: ([\w/-]+)/gm)].map(([, type]) => type);
  expect(structure).toEqual([
    'multipart/mixed',
    'multipart/alternative',
    'text/plain',
    'multipart/related',
    'text/html',
    'image/png',
    'application/pdf',
  ]);
});

test('an image the Markdown no longer shows goes out as an ordinary attachment', async () => {
  const { raw, parsed } = await sent({ ...draft, attachments: [photo] });
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0]).toMatchObject({ filename: 'ridge.png', disposition: 'attachment' });
  expect(parsed.attachments[0]!.contentId).toBeUndefined();
  expect(raw).not.toContain('multipart/related');
});

test('an image the Markdown shows but the draft does not carry fails, naming it', () => {
  expect(() =>
    messageOf({ ...draft, markdown: `![The ridge](cid:${ridge})`, attachments: [notes] }, copy),
  ).toThrow(`The image "The ridge" is the attachment ${ridge}, which the message doesn't carry.`);
});

test('a file the Markdown shows as an image must be one', () => {
  expect(() =>
    messageOf(
      {
        ...draft,
        markdown: `![Notes](cid:${ridge})`,
        attachments: [{ ...notes, contentId: ridge }],
      },
      copy,
    ),
  ).toThrow('The Markdown shows notes.pdf as an image, but it is application/pdf.');
});

test('two files cannot share a Content-ID', () => {
  expect(() =>
    messageOf(
      {
        ...draft,
        markdown: `![a](cid:${ridge})`,
        attachments: [photo, { ...photo, name: 'b.png' }],
      },
      copy,
    ),
  ).toThrow(`Two attachments have the Content-ID ${ridge}.`);
});

test('a message of only attachments has no HTML part', async () => {
  const { raw, parsed } = await sent({ ...draft, markdown: '', attachments: [notes] });
  expect(raw).not.toContain('text/html');
  expect(parsed.text ?? '').toBe('');
  expect(parsed.attachments.map(({ filename }) => filename)).toEqual(['notes.pdf']);
});

test("a pasted image's Content-ID is unique to it and names no one's server", () => {
  expect(contentIdFor('6f1c2b8e-0d4b-4c38-9d8e-3f0a1b2c3d4e')).toBe(
    '6f1c2b8e-0d4b-4c38-9d8e-3f0a1b2c3d4e@trailmix.invalid',
  );
});

test("a reply's subject gains one Re:", () => {
  expect(replySubject('The engine')).toBe('Re: The engine');
  expect(replySubject('Re: The engine')).toBe('Re: The engine');
  expect(replySubject('RE: The engine')).toBe('RE: The engine');
  expect(replySubject('re:The engine')).toBe('re:The engine');
  expect(replySubject('Re[2]: The engine')).toBe('Re[2]: The engine');
  expect(replySubject('Fwd: The engine')).toBe('Re: Fwd: The engine');
  expect(replySubject('Rebuilding the engine')).toBe('Re: Rebuilding the engine');
  expect(replySubject('')).toBe('Re:');
});

test('a reply goes to the sender, and a reply to all to everyone else but me', () => {
  const parent = { from: grace, to: [me, alan], cc: [edsger, { email: 'ADA@example.com' }] };
  expect(replyRecipients(parent, [me.email], false)).toEqual({ to: [grace], cc: [] });
  expect(replyRecipients(parent, [me.email], true)).toEqual({ to: [grace, alan], cc: [edsger] });
});

test('a reply to all names each address once, in the first place it would appear', () => {
  const parent = {
    from: grace,
    to: [alan, { email: 'GRACE@example.com' }],
    cc: [{ name: 'Alan', email: 'alan@EXAMPLE.org' }, edsger],
  };
  expect(replyRecipients(parent, [me.email], true)).toEqual({ to: [grace, alan], cc: [edsger] });
});

test('a reply to my own message goes where it went', () => {
  const parent = { from: me, to: [grace, alan], cc: [edsger] };
  expect(replyRecipients(parent, ['work@example.org', 'ADA@example.com'], false)).toEqual({
    to: [grace, alan],
    cc: [],
  });
  expect(replyRecipients(parent, [me.email], true)).toEqual({ to: [grace, alan], cc: [edsger] });
});

test('a signature goes under the message after the delimiter line, and only if there is one', () => {
  expect(withSignature('', 'Ada\n')).toBe('\n\n-- \nAda');
  expect(withSignature('Hello', '  **Ada**  ')).toBe('Hello\n\n-- \n**Ada**');
  expect(withSignature('Hello', undefined)).toBe('Hello');
  expect(withSignature('Hello', ' \n ')).toBe('Hello');
});

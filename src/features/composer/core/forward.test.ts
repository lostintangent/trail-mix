import { expect, test } from 'bun:test';
import PostalMime, { type Address as ParsedAddress } from 'postal-mime';
import { writeMime, type Address, type MimeAttachment } from '../../mail/core/index.ts';
import { contentIdFor, messageOf, type Composed } from './draft.ts';
import {
  cardOf,
  FORWARD_MARKER,
  forwardedIn,
  forwardOf,
  forwardSubject,
  imagesShownBy,
  noteOf,
  type ReadMessage,
} from './forward.ts';

const me: Address = { name: 'Ada Lovelace', email: 'ada@example.com' };
const grace: Address = { name: 'Grace Hopper', email: 'grace@example.com' };
const alan: Address = { name: 'Alan Turing', email: 'alan@example.org' };
const kernel: Address = { name: 'Kernel Weekly', email: 'news@kernel.example' };

const masthead: MimeAttachment = {
  name: 'masthead.png',
  type: 'image/png',
  content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
  contentId: 'masthead@kernel.example',
};
const report: MimeAttachment = {
  name: 'report.pdf',
  type: 'application/pdf',
  content: new TextEncoder().encode('%PDF-1.7'),
};

const newsletter = `<!DOCTYPE html>
<html class="light" lang="en"><head><meta charset="utf-8"><title>Kernel Weekly</title>
<style>body { margin: 0; color: #222 } .lead { font-size: 18px } @media (max-width: 600px) { .lead { font-size: 15px } }</style>
<script>alert(1)</script></head>
<body bgcolor="#f4f1ea" class="issue"><img src="cid:masthead@kernel.example" alt="Kernel Weekly">
<p class="lead">Schedulers, again.</p></body></html>`;

/** The original, as the Mailroom reads it from the bytes its sender wrote. */
async function original(html: string | undefined, text: string | undefined) {
  return read(
    writeMime({
      date: '2026-11-17T08:15:00.000Z',
      messageId: '<issue-42@kernel.example>',
      from: kernel,
      to: [me],
      cc: [alan],
      subject: 'Issue 42: schedulers',
      ...(text === undefined ? {} : { text }),
      ...(html === undefined ? {} : { html }),
      attachments: [masthead, report],
      boundary: 'original',
    }),
  );
}

/** A message read from its bytes, as the Mailroom reads one to forward it or carry a forward on. */
async function read(raw: string): Promise<ReadMessage> {
  const parsed = await PostalMime.parse(raw);
  const address = (each: ParsedAddress): Address => ({
    ...(each.name ? { name: each.name } : {}),
    email: each.address ?? '',
  });
  return {
    from: address(parsed.from!),
    to: (parsed.to ?? []).map(address),
    cc: (parsed.cc ?? []).map(address),
    subject: parsed.subject ?? '',
    messageId: parsed.messageId ?? '',
    references: [],
    ...(parsed.html === undefined ? {} : { html: parsed.html }),
    ...(parsed.text === undefined ? {} : { text: parsed.text }),
    headers: parsed.headers.map((header) => [header.originalKey, header.value]),
    attachments: parsed.attachments.map((each) => ({
      name: each.filename ?? '',
      type: each.mimeType,
      content: new Uint8Array(each.content as ArrayBuffer),
      ...(each.contentId ? { contentId: each.contentId.replace(/^<|>$/g, '') } : {}),
    })),
  };
}

/** A forward of `forwarded` with the note `markdown`, saved as Trail Mix saves it. */
function saved(forwarded: ReturnType<typeof forwardOf>, markdown: string, files: MimeAttachment[]) {
  const composed: Composed = {
    from: me,
    to: [grace],
    cc: [],
    bcc: [],
    subject: 'Fwd: Issue 42: schedulers',
    markdown,
    parent: { messageId: forwarded.messageId, references: [] },
    forwarded,
    attachments: files,
  };
  return writeMime(
    messageOf(composed, {
      date: '2026-11-18T09:30:00.000Z',
      messageId: '<draft-1@example.com>',
      boundary: 'forward',
    }),
  );
}

test('a forward writes the header block every client knows over the original’s text', async () => {
  const forwarded = forwardOf(await original(newsletter, 'Schedulers, again.\r\n'));
  expect(forwarded.text).toBe(
    [
      FORWARD_MARKER,
      'From: Kernel Weekly <news@kernel.example>',
      'Date: Tue, 17 Nov 2026 08:15:00 +0000',
      'Subject: Issue 42: schedulers',
      'To: Ada Lovelace <ada@example.com>',
      'Cc: Alan Turing <alan@example.org>',
      '',
      'Schedulers, again.',
    ].join('\n'),
  );
  expect(forwarded.messageId).toBe('<issue-42@kernel.example>');
});

test('a forward carries the original’s body, with no document, script or title of its own', async () => {
  const { html } = forwardOf(await original(newsletter, 'Schedulers, again.'));
  expect(html).toStartWith('<div class="trailmix-forward"><div style="font-family:');
  expect(html).toContain('<strong>Kernel Weekly</strong> &lt;news@kernel.example&gt;');
  expect(html).toContain(
    '<div class="trailmix-forwarded light" lang="en"><div class="issue" style="background-color: #f4f1ea">',
  );
  expect(html).toContain('<p class="lead">Schedulers, again.</p>');
  for (const gone of [
    '<html',
    '<head',
    '<body',
    '<meta',
    '<title',
    '<script',
    'alert(1)',
    '<style',
  ]) {
    expect(html).not.toContain(gone);
  }
});

test('the original’s style sheets reach only the original, its root and body included', async () => {
  const { css } = forwardOf(await original(newsletter, undefined));
  expect(css).toBe(
    [
      '.trailmix-forwarded > div { margin: 0; color: #222 }',
      '.trailmix-forwarded .lead { font-size: 18px }',
      '@media (max-width: 600px) {.trailmix-forwarded .lead { font-size: 15px }}',
    ].join('\n'),
  );
});

test('a forward takes along the images its original shows, and leaves its other files to the member', async () => {
  const forwarded = forwardOf(await original(newsletter, undefined));
  expect(forwarded.images.map(({ name, contentId }) => ({ name, contentId }))).toEqual([
    { name: 'masthead.png', contentId: 'masthead@kernel.example' },
  ]);
});

test('an original with only text is forwarded as that text, its spaces and lines kept', async () => {
  const forwarded = forwardOf(await original(undefined, 'Columns:\n  a  b\n<not a tag>'));
  expect(forwarded.html).toContain(
    '<div class="trailmix-forwarded"><div style="white-space: pre-wrap">Columns:<br>  a  b<br>&#60;not a tag&#62;</div></div>',
  );
  expect(forwarded.images).toEqual([]);
});

test('an original with only HTML is forwarded with text read from it, line by line', async () => {
  const forwarded = forwardOf(
    await original('<style>p{}</style><p>One &amp; two</p><div>Three<br>Four</div>', undefined),
  );
  expect(forwarded.text).toEndWith('\n\nOne & two\n\nThree\nFour');
});

test('a saved forward reads back as exactly what it forwards, so every later save carries the same', async () => {
  const forwarded = forwardOf(await original(newsletter, 'Schedulers, again.'));
  const first = saved(forwarded, 'Thought you’d like this.', []);
  const carried = forwardedIn(await read(first))!;
  expect(carried.html).toBe(forwarded.html);
  expect(carried.css).toBe(forwarded.css);
  expect(carried.text).toBe(forwarded.text);
  expect(carried.messageId).toBe(forwarded.messageId);
  expect(carried.images.map(({ contentId }) => contentId)).toEqual(['masthead@kernel.example']);
  expect(saved(carried, 'Thought you’d like this.', [])).toBe(first);
});

test('a saved forward holds the note, then the forward, in both parts and one document', async () => {
  const forwarded = forwardOf(await original(newsletter, 'Schedulers, again.'));
  const parsed = await PostalMime.parse(saved(forwarded, 'See **this**.', [report]));
  expect(parsed.text).toBe(`See **this**.\n\n${forwarded.text}`);
  expect(parsed.html).toStartWith('<html><head><style>.trailmix-forwarded > div');
  expect(parsed.html).toContain('</style></head><body><div style="font-family:');
  expect(parsed.html!.indexOf('See <strong>this</strong>')).toBeLessThan(
    parsed.html!.indexOf('<div class="trailmix-forward">'),
  );
  expect(parsed.headers.find(({ key }) => key === 'x-forwarded-message-id')?.value).toBe(
    '<issue-42@kernel.example>',
  );
  expect(parsed.inReplyTo).toBe('<issue-42@kernel.example>');
  expect(
    parsed.attachments.map(({ filename, disposition }) => ({ filename, disposition })),
  ).toEqual([
    { filename: 'masthead.png', disposition: 'inline' },
    { filename: 'report.pdf', disposition: 'attachment' },
  ]);
});

test('a forward with no note is the forward alone', async () => {
  const forwarded = forwardOf(await original(undefined, 'Hello.'));
  const draft = await read(saved(forwarded, '', []));
  expect(draft.text).toBe(forwarded.text);
  expect(noteOf(draft.text!)).toBe('');
  expect(forwardedIn(draft)?.html).toBe(forwarded.html);
});

test('a note is given back as written, even a line of it that reads as the marker', async () => {
  const forwarded = forwardOf(await original(undefined, `Inner\n\n${FORWARD_MARKER}\nFrom: x`));
  const markdown = `Above\n${FORWARD_MARKER}\n\\${FORWARD_MARKER}\n\n-- \nAda`;
  const draft = await read(saved(forwarded, markdown, []));
  expect(noteOf(draft.text!)).toBe(markdown);
  expect(forwardedIn(draft)?.text).toBe(forwarded.text);
});

test('a note’s images stay the note’s, and the forward’s stay the forward’s', async () => {
  const ridge = contentIdFor('6f1c2b8e-0d4b-4c38-9d8e-3f0a1b2c3d4e');
  const photo = { ...masthead, name: 'ridge.png', contentId: ridge };
  const forwarded = forwardOf(await original(newsletter, undefined));
  const draft = await read(saved(forwarded, `![Ridge](cid:${ridge})`, [photo]));
  expect(draft.attachments.map(({ contentId }) => contentId)).toEqual([
    ridge,
    'masthead@kernel.example',
  ]);
  expect(forwardedIn(draft)?.images.map(({ contentId }) => contentId)).toEqual([
    'masthead@kernel.example',
  ]);
});

test('a forward’s image the composer still carries goes once, as the forward’s', async () => {
  const forwarded = forwardOf(await original(newsletter, undefined));
  const draft = await read(saved(forwarded, 'Note', [masthead]));
  expect(draft.attachments.map(({ contentId }) => contentId)).toEqual(['masthead@kernel.example']);
});

test('a draft that forwards nothing, or that another client wrote, holds no forward of Trail Mix’s', async () => {
  const forwarded = forwardOf(await original(newsletter, undefined));
  const plain = writeMime(
    messageOf(
      {
        from: me,
        to: [grace],
        cc: [],
        bcc: [],
        subject: 'Hi',
        markdown: FORWARD_MARKER,
        attachments: [],
      },
      { date: '2026-11-18T09:30:00.000Z', messageId: '<d@example.com>', boundary: 'b' },
    ),
  );
  expect(forwardedIn(await read(plain))).toBeUndefined();
  // Another client's forward of a Trail Mix forward holds Trail Mix's under its own.
  const theirs = await read(saved(forwarded, '', []));
  expect(
    forwardedIn({
      ...theirs,
      html: `<div dir="ltr">FYI<div class="gmail_quote">${theirs.html}</div></div>`,
      text: `FYI\n\n${theirs.text}`,
    }),
  ).toBeUndefined();
});

test('a forward of a forward carries the one inside it, and reads back as the outer one', async () => {
  const inner = forwardOf(await original(newsletter, 'Schedulers, again.'));
  const first = await read(saved(inner, 'Have a look.', []));
  const outer = forwardOf({ ...first, from: me, to: [grace], cc: [] });
  expect(outer.css).toContain('.trailmix-forwarded .trailmix-forwarded > div { margin: 0');
  expect(outer.images.map(({ contentId }) => contentId)).toEqual(['masthead@kernel.example']);
  const second = await read(saved(outer, 'Passing it on.', []));
  expect(noteOf(second.text!)).toBe('Passing it on.');
  expect(forwardedIn(second)?.text).toBe(outer.text);
  expect(forwardedIn(second)?.html).toBe(outer.html);
});

test('a forward’s card names who sent the original, when and what about', async () => {
  const forwarded = forwardOf(await original(newsletter, 'Schedulers, again.'));
  expect(cardOf(forwarded)).toEqual({
    from: kernel,
    subject: 'Issue 42: schedulers',
    date: '2026-11-17T08:15:00.000Z',
  });
  expect(cardOf({ text: `${FORWARD_MARKER}\nFrom: x@example.com\nSubject: S\n\nFrom: y` })).toEqual(
    { from: { name: '', email: 'x@example.com' }, subject: 'S' },
  );
});

test('a forward’s subject says it forwards, once', () => {
  expect(forwardSubject('Issue 42')).toBe('Fwd: Issue 42');
  expect(forwardSubject('Fwd: Issue 42')).toBe('Fwd: Issue 42');
  expect(forwardSubject('FW: Issue 42')).toBe('FW: Issue 42');
  expect(forwardSubject('')).toBe('Fwd:');
});

test('the images HTML shows are those it names by cid:, decoded', () => {
  expect(
    imagesShownBy(
      '<img src="cid:a%40x"><td background=cid:b@x style="background:url(&quot;cid:c@x&quot;)"><img src="https://x/cid:no">',
    ),
  ).toEqual(new Set(['a@x', 'b@x', 'c@x']));
});

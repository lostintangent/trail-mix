import { expect, test } from 'bun:test';
import { addressesIn, type Account, type Body, type Message } from '../../mail/core/index.ts';
import {
  addressText,
  afterSave,
  draftInputOf,
  newMessage,
  reopened,
  replyTo,
  type Attached,
} from './session.ts';

const account: Account = {
  id: 'personal',
  name: 'Personal',
  address: 'ada@example.com',
  provider: 'demo',
  stamp: 'vermilion',
  signature: 'Ada',
  allowImagesFrom: [],
  lightPaperFrom: [],
  status: 'ready',
};

const grace = { name: 'Grace Hopper', email: 'grace@example.com' };
const alan = { name: 'Alan Turing', email: 'alan@example.org' };

const parent: Message = {
  account: 'personal',
  path: 'INBOX',
  uidValidity: 1,
  uid: 7,
  messageId: '<engine@example.com>',
  references: [],
  from: grace,
  to: [{ email: 'ada@example.com' }, alan],
  cc: [],
  subject: 'The engine',
  date: '2026-11-10T09:00:00.000Z',
  preview: 'Shall we',
  flags: { seen: true, flagged: false, answered: false, draft: false },
  hasAttachments: false,
  verified: false,
  conversation: 'c1',
};

const noBody: Body = { attachments: [], headers: [] };

test('a reply goes to the sender, threads under the parent, and is signed', () => {
  expect(replyTo(parent, noBody, account, false)).toEqual({
    account: 'personal',
    to: [grace],
    cc: [],
    bcc: [],
    subject: 'Re: The engine',
    markdown: '',
    signature: 'Ada',
    inReplyTo: { account: 'personal', path: 'INBOX', uidValidity: 1, uid: 7 },
    attachments: [],
  });
});

test('a reply follows the parent’s Reply-To, and a reply to all leaves the member out', () => {
  const list: Body = { attachments: [], headers: [['Reply-To', 'Engines <list@example.net>']] };
  expect(replyTo(parent, list, account, false).to).toEqual([
    { name: 'Engines', email: 'list@example.net' },
  ]);
  expect(replyTo(parent, noBody, account, true).to).toEqual([grace, alan]);
});

test('a draft saves its signature under the `-- ` line, and reads it back apart', () => {
  const saved = draftInputOf({ ...newMessage(account), markdown: 'See you there.' }).markdown;
  expect(saved).toBe('See you there.\n\n-- \nAda');
  const draft = { ...parent, flags: { ...parent.flags, draft: true } };
  const writing = reopened(draft, { text: saved, attachments: [], headers: [] }, []);
  expect([writing.markdown, writing.signature]).toEqual(['See you there.', 'Ada']);
  expect(draftInputOf(newMessage({ ...account, signature: undefined })).markdown).toBe('');
});

test('a draft opens with its words as written, its files as stored parts, and its parent', () => {
  const draft: Message = {
    ...parent,
    path: 'Drafts',
    uid: 3,
    messageId: '<draft@trailmix.invalid>',
    from: { email: 'ada@example.com' },
    to: [grace],
    subject: 'Re: The engine',
    flags: { ...parent.flags, draft: true },
  };
  const text = 'The **analytical** engine\n\n![chart](cid:chart@trailmix.invalid)';
  const body: Body = {
    text,
    attachments: [
      {
        id: '0',
        name: 'chart.png',
        type: 'image/png',
        size: 4,
        contentId: 'chart@trailmix.invalid',
      },
    ],
    headers: [
      ['In-Reply-To', '<engine@example.com>'],
      ['Bcc', 'Edsger <edsger@example.net>'],
    ],
  };

  const writing = reopened(draft, body, [parent, draft]);

  expect(writing.markdown).toBe(text);
  expect(writing.bcc).toEqual([{ name: 'Edsger', email: 'edsger@example.net' }]);
  expect(writing.inReplyTo).toEqual({ account: 'personal', path: 'INBOX', uidValidity: 1, uid: 7 });
  expect(writing.attachments).toEqual([
    {
      in: { account: 'personal', path: 'Drafts', uidValidity: 1, uid: 3 },
      id: '0',
      name: 'chart.png',
      type: 'image/png',
      size: 4,
      contentId: 'chart@trailmix.invalid',
    },
  ]);
});

test('a draft whose parent the conversation doesn’t hold names no message, but still answers it', () => {
  const body: Body = { text: 'Hi', attachments: [], headers: [['In-Reply-To', '<gone@x>']] };
  const writing = reopened({ ...parent, flags: { ...parent.flags, draft: true } }, body, []);
  expect(writing.inReplyTo).toBe(undefined);
  expect(writing.answers).toBe('<gone@x>');
  // The Mailroom keeps its threading from the draft itself, so a save doesn't carry it.
  expect(draftInputOf(writing)).not.toContainKey('answers');
  // A draft that answers nothing is no reply.
  expect(reopened(parent, { ...body, headers: [] }, [])).not.toContainKey('answers');
});

test('after a save, each file is named by the part of the saved draft that holds it', () => {
  const saved = { account: 'personal', path: 'Drafts', uidValidity: 1, uid: 9 };
  const chart = new File([new Uint8Array(4)], 'chart.png', { type: 'image/png' });
  const notes = new File([new Uint8Array(3)], 'notes.txt', { type: 'text/plain' });
  const attachments: Attached[] = [
    { file: notes },
    { file: chart, contentId: 'chart@trailmix.invalid' },
    {
      in: { ...saved, uid: 8 },
      id: '0',
      name: 'plan.pdf',
      type: 'application/pdf',
      size: 10,
    },
  ];
  const body: Body = {
    attachments: [
      {
        id: '0',
        name: 'chart.png',
        type: 'image/png',
        size: 4,
        contentId: 'chart@trailmix.invalid',
      },
      { id: '1', name: 'plan.pdf', type: 'application/pdf', size: 10 },
      { id: '2', name: 'notes.txt', type: 'text/plain', size: 3 },
    ],
    headers: [],
  };

  expect(
    afterSave(attachments, saved, body).map((attached) => 'id' in attached && attached.id),
  ).toEqual(['2', '0', '1']);
  const writing = {
    ...newMessage(account),
    markdown: '![chart](cid:chart@trailmix.invalid)',
    attachments: afterSave(attachments, saved, body),
  };
  expect(draftInputOf(writing).attachments).toEqual([
    { in: saved, id: '2' },
    { in: saved, id: '0' },
    { in: saved, id: '1' },
  ]);
});

test('an image taken out of the text leaves the draft with it, and other files stay', () => {
  const chart = new File([new Uint8Array(4)], 'chart.png', { type: 'image/png' });
  const notes = new File([new Uint8Array(3)], 'notes.txt');
  const writing = {
    ...newMessage(account),
    markdown: 'No picture after all.',
    attachments: [{ file: chart, contentId: 'chart@trailmix.invalid' }, { file: notes }],
  };
  expect(draftInputOf(writing).attachments).toEqual([{ file: notes }]);
});

test('after a save, a file the saved draft doesn’t hold stays as bytes to send again', () => {
  const notes = new File([new Uint8Array(3)], 'notes.txt');
  const saved = { account: 'personal', path: 'Drafts', uidValidity: 1, uid: 9 };
  expect(afterSave([{ file: notes }], saved, noBody)).toEqual([{ file: notes }]);
});

test('addresses read back from a field as they were written, names with commas included', () => {
  const written = [
    { name: 'Liddell, Alice', email: 'alice@example.com' },
    grace,
    { email: 'x@y.z' },
  ];
  expect(addressText(written)).toBe(
    '"Liddell, Alice" <alice@example.com>, Grace Hopper <grace@example.com>, x@y.z',
  );
  expect(addressesIn(addressText(written))).toEqual(written);
});

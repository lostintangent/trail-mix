import type { Account, Body, Message, MessageRef } from '../../../src/features/mail/core/index.ts';

/**
 * Conversations for the reader's tests and screenshots, made of the corpus's real-world mail.
 * Names and addresses are invented.
 */

export type Fixture = {
  account: Account;
  conversation: Message[];
  bodies: Record<string, Body>;
};

export const ACCOUNT: Account = {
  id: 'personal',
  name: 'Personal',
  address: 'me@trailmix.test',
  provider: 'demo',
  stamp: 'vermilion',
  status: 'ready',
  allowImagesFrom: [],
  lightPaperFrom: [],
};

const ada = { name: 'Ada Park', email: 'ada@example.com' };
const me = { name: 'Jonas Berg', email: 'me@trailmix.test' };

/** The key a fixture's bodies are kept under, which `bodyOf` looks up. */
export const bodyKey = ({ path, uid }: MessageRef) => `${path}/${uid}`;

function message(
  uid: number,
  fields: Partial<Message> & Pick<Message, 'subject' | 'date'>,
): Message {
  return {
    account: ACCOUNT.id,
    path: 'INBOX',
    uidValidity: 1,
    uid,
    messageId: `<${uid}@example.com>`,
    references: [],
    from: ada,
    to: [me],
    cc: [],
    preview: '',
    flags: { seen: true, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    verified: false,
    conversation: 'lunch',
    ...fields,
  };
}

/** A three-message thread: a plain-text question, a reply, and an HTML answer with attachments. */
export function lunchThread(): Fixture {
  const question = message(5, {
    subject: 'Lunch on Thursday?',
    date: '2026-11-09T10:02:00.000Z',
    preview: 'Are you free for lunch this week? Thursday or Friday both suit me.',
  });
  const reply = message(6, {
    path: 'Sent',
    from: me,
    to: [ada],
    subject: 'Re: Lunch on Thursday?',
    date: '2026-11-09T11:15:00.000Z',
    preview: "Thursday works for me. I'll book the table by the window.",
  });
  const answer = message(7, {
    subject: 'Re: Lunch on Thursday?',
    date: '2026-11-09T12:40:00.000Z',
    preview: "Perfect, Thursday it is. The menu is attached, and here's where we're going.",
    hasAttachments: true,
  });
  return {
    account: ACCOUNT,
    conversation: [answer, question, reply],
    bodies: {
      [bodyKey(question)]: {
        text: 'Are you free for lunch this week? Thursday or Friday both suit me.\n\nAda',
        attachments: [],
        headers: headers(question),
      },
      [bodyKey(reply)]: {
        text: [
          "Thursday works for me. I'll book the table by the window.",
          '',
          'Jonas',
          '',
          'On Mon, Nov 9, 2026 at 10:02 AM Ada Park <ada@example.com> wrote:',
          '> Are you free for lunch this week? Thursday or Friday both suit me.',
          '>',
          '> Ada',
        ].join('\n'),
        attachments: [],
        headers: headers(reply),
      },
      [bodyKey(answer)]: {
        // Gmail's markup, quoting Jonas's reply below Ada's answer.
        html: [
          `<div dir="ltr">Perfect, Thursday it is. The menu is attached, and here's where we're going:`,
          `<div><img src="cid:map@example.com" alt="A map of the station" width="240" height="120"></div>`,
          `<div><br></div><div>Ada</div></div><br>`,
          `<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Nov 9, 2026 at 11:15 AM Jonas Berg &lt;<a href="mailto:me@trailmix.test">me@trailmix.test</a>&gt; wrote:<br></div>`,
          `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">`,
          `<div dir="ltr">Thursday works for me. I'll book the table by the window.<div><br></div><div>Jonas</div></div></blockquote></div>`,
        ].join(''),
        attachments: [
          {
            id: '0',
            name: 'map.png',
            type: 'image/png',
            size: 48_213,
            contentId: 'map@example.com',
          },
          { id: '1', name: 'Autumn menu.pdf', type: 'application/pdf', size: 1_284_551 },
        ],
        headers: headers(answer),
      },
    },
  };
}

/** One newsletter, with its remote images and its own colors. */
export function newsletter(html: string): Fixture {
  const issue = message(9, {
    conversation: 'trailhead',
    from: { name: 'The Trailhead', email: 'news@trailhead.example.com' },
    subject: 'Three trails for the first frost',
    date: '2026-11-09T07:00:00.000Z',
    preview: 'Three trails for the first frost, and a new map of the ridge.',
  });
  return {
    account: ACCOUNT,
    conversation: [issue],
    bodies: { [bodyKey(issue)]: { html, attachments: [], headers: headers(issue) } },
  };
}

function headers(message: Message): [string, string][] {
  return [
    ['From', `${message.from.name} <${message.from.email}>`],
    ['To', message.to.map(({ name, email }) => `${name} <${email}>`).join(', ')],
    ['Subject', message.subject],
    ['Date', new Date(message.date).toUTCString()],
    ['Message-ID', message.messageId],
  ];
}

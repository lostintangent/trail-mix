import {
  addressOf,
  refOf,
  type AccountId,
  type ConversationId,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';

/** What one notification says, and where a tap leads. */
export type Notice = {
  title: string;
  body: string;
  /** What it's about, so a newer notice about the same thing replaces it rather than piling up. */
  tag: string;
  /** Where a tap opens: the conversation, or the unified Inbox for a summary. */
  navigate: string;
  /** The message Archive and Mark read act on, for a notice about one conversation. */
  message?: MessageRef;
};

/** How many conversations one wake notifies of one by one. More are told as one summary. */
const MOST_NOTICES = 3;

/** How much of a subject or preview a notice carries, so every push stays well inside its size. */
const SAID_LENGTH = 200;

/**
 * What a wake's news says: a notice per conversation, about its newest news, or one summary when
 * more conversations than `MOST_NOTICES` have news, naming the accounts it came to.
 */
export function noticesOf(
  news: readonly Message[],
  accountName: (id: AccountId) => string | undefined,
): Notice[] {
  const newest = new Map<ConversationId, Message>();
  for (const message of news) {
    const held = newest.get(message.conversation);
    if (!held || held.date < message.date) newest.set(message.conversation, message);
  }
  const conversations = [...newest.values()].toSorted((a, b) => b.date.localeCompare(a.date));
  if (conversations.length > MOST_NOTICES) return [summaryOf(news, accountName)];
  return conversations.map((message) => ({
    title: clipped(message.from.name || message.from.email),
    body: [message.subject, message.preview]
      .map((text) => clipped(text.trim()))
      .filter((text) => text !== '')
      .join('\n'),
    tag: message.conversation,
    navigate: addressOf({ view: { in: 'inbox' }, open: message.conversation }),
    message: refOf(message),
  }));
}

function summaryOf(news: readonly Message[], accountName: (id: AccountId) => string | undefined) {
  const accounts = [...new Set(news.map(({ account }) => account))].map(
    (id) => accountName(id) ?? id,
  );
  return {
    title: `${news.length} new messages`,
    body: `In ${listed(accounts)}`,
    tag: 'news',
    navigate: addressOf({ view: { in: 'inbox' } }),
  };
}

/** Names in a sentence: "Personal", "Personal and Work", "Personal, Work and Home". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Text cut to `SAID_LENGTH` characters, whole ones, so no emoji is split in half. */
function clipped(text: string): string {
  const characters = [...text];
  return characters.length > SAID_LENGTH
    ? `${characters.slice(0, SAID_LENGTH - 1).join('')}…`
    : text;
}

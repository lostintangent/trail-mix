import {
  domainOf,
  writeMime,
  type Address,
  type Envelope,
  type Flags,
  type FolderRole,
  type MessageRef,
  type MimeAttachment,
  type StampColor,
} from '../../mail/core/index.ts';
import { seededRandom } from '../../../shared/random.ts';
import { isDemoVerified } from './pictures.ts';

/**
 * What the demo mailbox says. Two accounts, Personal and Work, each a cycle of stories laid out
 * newest first and repeated back in time until the Inbox holds as many messages as asked. The
 * newest cycle is the one the prototypes show: unread mail, a flagged message, attachments, a
 * GitHub thread, a newsletter, long threads, Sent replies and drafts, one of them to a host that
 * turns its first try away. Older cycles vary who writes and what they say, by lists of different
 * lengths, so no two rows of the public demo share a subject and how their preview opens, and most
 * of their mail is read.
 *
 * A message is a pure function of its account, the mailbox's size, its creation time and its UID,
 * so no message exists until it is read, and the same inputs always give the same bytes.
 */

export type DemoKind = 'personal' | 'work';

/**
 * The name the demo's receiving server signs its Authentication-Results with, as a preset names a
 * real host's. It vouches for the demo's verified list mail and for nothing else.
 */
export const DEMO_SIGNERS: readonly string[] = ['mx.trailmix.test'];

/** What a message says, apart from where it is and its flags. */
export type Content = Omit<Envelope, keyof MessageRef | 'flags'>;

/** A seeded message. Its flags and date are cheap, and what it says is made only when asked. */
export type SeededMessage = {
  folder: string;
  flags: Flags;
  date: string;
  content(): Content;
  /** The text of its body, for search. */
  text(): string;
  raw(): string;
};

export const DEMO_ACCOUNTS: Record<DemoKind, { name: string; me: Address; stamp: StampColor }> = {
  personal: {
    name: 'Personal',
    me: { name: 'Sam Rivera', email: 'sam@trailmix.test' },
    stamp: 'vermilion',
  },
  work: {
    name: 'Work',
    me: { name: 'Sam Rivera', email: 'sam@work.trailmix.test' },
    stamp: 'teal',
  },
};

export const SEEDED_FOLDERS: Record<DemoKind, { path: string; role?: FolderRole }[]> = {
  personal: [...roleFolders(), { path: 'Projects' }, { path: 'Projects/Toy Box' }],
  work: [...roleFolders(), { path: 'Receipts' }],
};

/** How many messages a mailbox holds in all, for an Inbox of `inbox` messages. */
export function seededSize(kind: DemoKind, inbox: number): number {
  const { newest, older } = foldersByPosition(kind);
  const perCycle = older.filter((folder) => folder === 'INBOX').length;
  let size = 0;
  let found = 0;
  while (found < inbox) {
    const cycle = newest.length;
    // Every cycle after the newest holds the same mail, so whole ones are counted at once.
    if (size >= cycle && size % cycle === 0 && inbox - found > perCycle) {
      const cycles = Math.floor((inbox - found - 1) / perCycle);
      size += cycles * cycle;
      found += cycles * perCycle;
    } else {
      if ((size < cycle ? newest : older)[size % cycle] === 'INBOX') found++;
      size++;
    }
  }
  return size;
}

/** Each seeded folder's UIDs, ascending, and how many of them are unread. Made once per size. */
export function seededFolders(
  kind: DemoKind,
  size: number,
): ReadonlyMap<string, { uids: readonly number[]; unread: number }> {
  const key = `${kind}/${size}`;
  const cached = SEEDED.get(key);
  if (cached) return cached;
  const folders = new Map<string, { uids: number[]; unread: number }>();
  for (let uid = 1; uid <= size; uid++) {
    const { folder, flags } = placeAt(kind, size - uid);
    const entry = folders.get(folder) ?? { uids: [], unread: 0 };
    entry.uids.push(uid);
    if (!flags.seen) entry.unread++;
    folders.set(folder, entry);
  }
  SEEDED.set(key, folders);
  return folders;
}

const SEEDED = new Map<string, ReadonlyMap<string, { uids: readonly number[]; unread: number }>>();

/** The seeded message with this UID, oldest first from 1, or nothing past the mailbox's size. */
export function seededMessage(
  kind: DemoKind,
  size: number,
  createdAt: string,
  uid: number,
): SeededMessage | undefined {
  if (!Number.isInteger(uid) || uid < 1 || uid > size) return undefined;
  const rank = size - uid;
  const { cycle, key, index, thread, step, folder, flags } = placeAt(kind, rank);
  const me = DEMO_ACCOUNTS[kind].me;

  const author = (from: Step['from']) =>
    from === 'me' ? me : { ...thread.cast[from]!, ...(thread.via ? { email: thread.via } : {}) };
  const idOf = (i: number) =>
    thread.steps[i]!.id ??
    `<${key}.${cycle}.${i}@${author(thread.steps[i]!.from).email.split('@')[1]}>`;
  const dateAt = (i: number) => {
    const position = LAYOUT[kind].findIndex(([k, s]) => k === key && s === i);
    return dateOf(cycle * LAYOUT[kind].length + position, size, createdAt);
  };
  const text = () => {
    const previous = thread.steps[index - 1];
    const quoted =
      step.quotes && previous ? quote(previous.text, author(previous.from), dateAt(index - 1)) : '';
    return `${step.text}${quoted}`;
  };
  const content = (): Content => {
    const others = thread.cast.filter((_, i) => i !== step.from);
    return {
      messageId: idOf(index),
      references: [
        ...(thread.root ? [thread.root] : []),
        ...thread.steps.slice(0, index).map((_, i) => idOf(i)),
      ],
      from: author(step.from),
      to: step.from === 'me' ? thread.cast : thread.group ? [me, ...others] : [me],
      cc: [],
      subject: index > 0 ? `Re: ${thread.subject}` : thread.subject,
      date: dateAt(index),
      preview: step.text.replace(/\s+/g, ' ').trim().slice(0, 200),
      hasAttachments: step.files !== undefined,
      verified: isDemoVerified(author(step.from).email),
      ...(thread.list
        ? { list: { id: thread.list.id, unsubscribe: thread.list.unsubscribe } }
        : {}),
    };
  };
  const sender = author(step.from).email;
  const list: [string, string][] = thread.list
    ? [
        ...(isDemoVerified(sender) ? vouchedFor(domainOf(sender), `${key}.${cycle}.${index}`) : []),
        ['List-Id', `${thread.list.name} <${thread.list.id}>`],
        ['List-Unsubscribe', thread.list.unsubscribe],
        ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
      ]
    : [];

  return {
    folder,
    flags,
    date: dateOf(rank, size, createdAt),
    content,
    text,
    raw: () =>
      writeMime({
        ...content(),
        headers: [...list, ...(step.headers ?? [])],
        ...(step.htmlOnly ? {} : { text: text() }),
        ...(step.plain ? {} : { html: step.html?.() ?? htmlOf(text()) }),
        attachments: step.files?.() ?? [],
        boundary: `${key}.${cycle}.${index}`,
      }),
  };
}

/**
 * What a verified sender's list mail carries, as a real one would: the sender's DKIM signature over
 * its list headers, and the demo's server's word that it and DMARC passed, so its one-click offer
 * qualifies. Nothing checks the signature's bytes, which only stand in for one.
 */
function vouchedFor(domain: string, seed: string): [string, string][] {
  const bytes = btoa(`${seed}@${domain}`.padEnd(48, '.'));
  return [
    [
      'Authentication-Results',
      `${DEMO_SIGNERS[0]}; dkim=pass header.d=${domain} header.s=demo; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=reject) header.from=${domain}`,
    ],
    [
      'DKIM-Signature',
      `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=demo; h=From:To:Subject:Date:Message-ID:List-Id:List-Unsubscribe:List-Unsubscribe-Post; bh=${bytes}; b=${bytes}`,
    ],
  ];
}

/** Where the message `rank` places back from the newest sits: its story, folder and flags. */
function placeAt(kind: DemoKind, rank: number) {
  const layout = LAYOUT[kind];
  const cycle = Math.floor(rank / layout.length);
  const [key, index] = layout[rank % layout.length]!;
  const thread = STORIES[key]!(cycle);
  const step = thread.steps[index]!;
  const newest = cycle === 0;
  const draft = newest && step.draft === true;
  const filed = newest ? undefined : thread.filed;
  const folder =
    step.from === 'me' ? (draft ? 'Drafts' : 'Sent') : (filed ?? thread.folder ?? 'INBOX');
  const random = seededRandom(rank * 2 + (kind === 'work' ? 1 : 0))();
  const flags: Flags = {
    seen: step.from === 'me' || (newest ? !step.unread : random >= (thread.list ? 0.2 : 0.03)),
    flagged: step.from !== 'me' && (newest ? step.flagged === true : random < 0.02),
    answered: thread.steps
      .slice(index + 1)
      .some((later) => later.from === 'me' && !(newest && later.draft)),
    draft,
  };
  return { cycle, key, index, thread, step, folder, flags };
}

/** The folder of each position in the newest cycle, and in every cycle after it. */
function foldersByPosition(kind: DemoKind) {
  const length = LAYOUT[kind].length;
  return {
    newest: LAYOUT[kind].map((_, i) => placeAt(kind, i).folder),
    older: LAYOUT[kind].map((_, i) => placeAt(kind, length + i).folder),
  };
}

// The stories. Each is a function of its cycle, so older cycles vary who writes and about what.

type Thread = {
  subject: string;
  /** Who writes, besides me. A step names its author by position here. */
  cast: Address[];
  steps: Step[];
  /** Everyone in the cast receives every message, not only me. */
  group?: boolean;
  /** Where mail from others lands: the Inbox unless set. */
  folder?: string;
  /** Where mail from others in older cycles has been filed away. */
  filed?: string;
  /** A notification service that sends on its people's behalf from one address. */
  via?: string;
  /** A Message-ID the thread hangs from that nobody here holds, as a pull request's own. */
  root?: string;
  list?: { name: string; id: string; unsubscribe: string };
};

type Step = {
  from: 'me' | number;
  text: string;
  /** Made from the text unless set, and left out when `plain`. Made only when the bytes are. */
  html?: () => string;
  plain?: boolean;
  /** Written as HTML alone, with no text part, as some clients save a draft. */
  htmlOnly?: boolean;
  /** Quotes the message before it, as a reply does. */
  quotes?: boolean;
  /** Made only when the message's bytes are. */
  files?: () => MimeAttachment[];
  headers?: [string, string][];
  id?: string;
  /** How the newest cycle shows it. Older cycles are mostly read. */
  unread?: boolean;
  flagged?: boolean;
  /** In the newest cycle, a message still being written. Older cycles sent it. */
  draft?: boolean;
};

/** The domain the demo's mail server can't reach on a message's first try. */
export const UNREACHABLE = 'unreachable.example';

/** The seeded folder the demo's server won't delete on the first try, as if another session had it open. */
export const BUSY_FOLDER = 'Projects';

/** The one-click unsubscribe the shop's list server turns away on its first try. */
export const BUSY_LIST = 'https://shop.example.com/unsubscribe?list=orders&u=demo';

const PEOPLE: Address[] = [
  { name: 'Ada Park', email: 'ada@example.com' },
  { name: 'Mina Okafor', email: 'mina@example.org' },
  { name: 'Jonas Weber', email: 'jonas@example.net' },
  { name: 'Theo Lindqvist', email: 'theo@example.com' },
  { name: 'Hana Sato', email: 'hana@example.org' },
  { name: 'Priya Raman', email: 'priya@example.com' },
  { name: 'Kwame Mensah', email: 'kwame@example.net' },
  { name: 'Sofia Marín', email: 'sofia@example.com' },
  { name: 'Luca Bianchi', email: 'luca@example.org' },
  { name: 'Noor Haddad', email: 'noor@example.net' },
];

/** The person at `index` in the newest cycle, and someone else further back. */
const person = (index: number, cycle: number) => PEOPLE[(index + cycle) % PEOPLE.length]!;

/** The first item in the newest cycle, and the others in turn further back. */
const rotate = <T>(items: readonly T[], cycle: number) => items[cycle % items.length]!;

/** Text as it starts a sentence. */
const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

const GITHUB = {
  name: 'trailmix-demo/toy-box',
  id: 'toy-box.trailmix-demo.github.com',
  unsubscribe: '<https://github.com/notifications/unsubscribe/demo>',
};

/** The newest cycle's review request. Its checks run on a PR three numbers before it. */
const NEWEST_PULL = 40_412;

/**
 * A cycle's pull request numbers, as GitHub's: one number is one pull request, so no two stories or
 * cycles share one, and newer cycles have higher ones. Each cycle takes four numbers, leaving room
 * for other people's pull requests between its two. They stay positive for ten thousand cycles,
 * twice the bench's mailbox.
 */
const pullNumber = (cycle: number, story: 'review' | 'checks') =>
  NEWEST_PULL - 4 * cycle - (story === 'checks' ? 3 : 0);

const STORIES: Record<string, (cycle: number) => Thread> = {
  plan: (c) => {
    // The newest cycle's plan, then others, each opened a little differently as I send it.
    const { subject, ask, what, doubt, points, notes } = rotate(
      [
        {
          subject: 'Workers migration plan',
          ask: 'Could you write up how sync would move into the Worker? I would like to see the outbox part before we commit to it.',
          what: 'moving sync into one Durable Object per owner',
          doubt:
            'The part I am least sure about is the outbox: when a send is undone, the draft has to come back untouched.',
          points: [
            'One Mailroom per member, holding the index and the outbox',
            'Sync folds events from a cursor, so a cold start just resumes',
            'Undo send and send later share one schedule',
          ],
          notes: [
            'The Durable Object approach looks right. Two notes on the outbox:',
            '',
            '- Store the message before the undo timer starts.',
            '- Remove the draft only after the server accepts the send.',
            '',
            '    outbox.enqueue(draft, { sendAt: now + 10_000 })',
          ],
        },
        {
          subject: 'Sync service rewrite',
          ask: 'Could you sketch how sync would work if we rewrote it around cursors? I would like to see how a reconnect resumes before we start.',
          what: 'rewriting sync around one cursor per folder',
          doubt:
            'The part I am least sure about is a cursor that outlives its folder, as when another device renames it.',
          points: [
            'Each folder keeps its own cursor and UIDVALIDITY',
            'A reconnect resumes from the stored cursor',
            'A changed UIDVALIDITY starts that folder over',
          ],
          notes: [
            'This reads well. Two things before we start:',
            '',
            '- Store the cursor only after the fold is stored.',
            '- Log every start-over, so we can see how often it happens.',
            '',
            '    sync.resume(folder, { from: cursor })',
          ],
        },
        {
          subject: 'Storage move plan',
          ask: 'Could you write up how we would move opened bodies into object storage? I would like to see what happens to the old cache before we decide.',
          what: 'moving opened bodies into object storage',
          doubt:
            'The part I am least sure about is the cache that is already there, since moving it all at once would take hours.',
          points: [
            'New bodies go to object storage from day one',
            'Old ones move as they are next opened',
            'Nothing is deleted until both copies match',
          ],
          notes: [
            'Moving them as they are opened is the right call. Two notes:',
            '',
            '- Key each body by its message, never by a path.',
            '- Keep the old cache readable until the move is done.',
            '',
            "    bodies.put(ref, raw, { onlyIf: 'absent' })",
          ],
        },
      ],
      c,
    );
    const opening = rotate(
      [
        'Here is the draft plan',
        'Here is a first pass at the plan',
        'Here is the plan as far as I have it',
        'Here is my write-up of the plan',
        'Here is a rough plan',
        'Here is the plan we talked about',
        'Here is an outline of the plan',
      ],
      c,
    );
    return {
      subject,
      cast: [person(0, c)],
      steps: [
        { from: 0, text: ask },
        {
          from: 'me',
          quotes: true,
          text: [
            `${opening} for ${what}. ${doubt}`,
            '',
            ...points.map((point) => `- ${point}`),
          ].join('\n'),
        },
        {
          from: 0,
          quotes: true,
          unread: true,
          // How the notes open turns at its own rate, so a plan's notes never read the same twice.
          text: `${rotate(
            [
              '',
              'Thanks for writing this up. ',
              'Read it on the train. ',
              'Sorry for the slow reply. ',
              'Finally had a proper look. ',
              'Good timing on this. ',
              'Just read it twice. ',
            ],
            c,
          )}${notes.join('\n')}`,
        },
      ],
    };
  },

  pr412: (c) => {
    const number = pullNumber(c, 'review');
    const { title, change, question } = rotate(
      [
        {
          title: 'Replayable stream cursors',
          change:
            'the cursor now names where a replay starts, so a reconnect resumes instead of starting over.',
          question:
            'Looks good overall. One question on the encoding: should a cursor from an older version start over instead of failing?',
        },
        {
          title: 'Snap side panels to a rail',
          change:
            'a panel dragged below its midpoint now snaps to its rail, and keeps its width for when it comes back.',
          question:
            'Nice. Could the snap point follow the window, so a narrow window does not snap every panel at once?',
        },
        {
          title: 'Cache opened bodies',
          change:
            'a body is fetched from the server the first time it is opened, and kept after that.',
          question:
            'This is a big win on slow connections. Should a cached body ever expire, or does it live as long as its message?',
        },
        {
          title: 'Retry sends with backoff',
          change:
            'a send the server turns away is tried again after 30 seconds, then 2 minutes, then 10.',
          question:
            'Looks right to me. Should the third failure tell the sender, rather than waiting for the fourth?',
        },
      ],
      c,
    );
    const id = (step: number) => `<trailmix-demo/toy-box/pull/${number}/c${c}/${step}@github.com>`;
    return {
      subject: `[trailmix-demo/toy-box] ${title} (PR #${number})`,
      cast: [person(3, c), person(8, c)],
      via: 'notifications@github.com',
      root: `<trailmix-demo/toy-box/pull/${number}@github.com>`,
      list: GITHUB,
      steps: [
        {
          from: 0,
          id: id(0),
          unread: true,
          headers: [['X-GitHub-Reason', 'review_requested']],
          text: `@sam-rivera, your review was requested on #${number}.\n\n${title}: ${change}`,
        },
        {
          from: 1,
          id: id(1),
          unread: true,
          headers: [['X-GitHub-Reason', 'comment']],
          text: question,
        },
      ],
    };
  },

  pr409: (c) => {
    const number = pullNumber(c, 'checks');
    return {
      subject: `[trailmix-demo/toy-box] Fix the flaky watch test (PR #${number})`,
      cast: [person(3, c)],
      via: 'notifications@github.com',
      root: `<trailmix-demo/toy-box/pull/${number}@github.com>`,
      list: GITHUB,
      filed: 'Projects/Toy Box',
      steps: [
        {
          from: 0,
          id: `<trailmix-demo/toy-box/pull/${number}/c${c}/checks@github.com>`,
          unread: true,
          headers: [['X-GitHub-Reason', 'ci_activity']],
          text: `All checks have passed on #${number}.\n\n3 successful checks: test, lint, build.`,
        },
      ],
    };
  },

  photos: (c) => {
    // The place and what's said of it turn at different rates, so no two cycles say the same.
    const place = rotate(['ridge', 'lake', 'coast', 'old harbor', 'pass'], c);
    const text = `Here are the ones from the ${place}. ${rotate(
      [
        'The second is my favorite of the whole week.',
        'The light was better than I expected.',
        'I like the last one best, even with my thumb in it.',
        'Two are blurry, but I kept them anyway.',
      ],
      c,
    )}`;
    return {
      subject: rotate(['Trip photos', `Photos from the ${place}`, `The ${place}, finally`], c),
      cast: [person(1, c)],
      filed: 'Archive',
      steps: [
        {
          from: 0,
          unread: true,
          flagged: true,
          text,
          html: () =>
            `<p>${text}</p><p><img src="cid:ridge@example.org" alt="The ${place} at dawn" width="320"></p>`,
          files: () => [
            {
              name: 'ridge.png',
              type: 'image/png',
              content: RIDGE(),
              contentId: 'ridge@example.org',
            },
            { name: 'lake.png', type: 'image/png', content: LAKE() },
          ],
        },
      ],
    };
  },

  lunch: (c) => {
    const { subject, ask, answer } = rotate(
      [
        {
          subject: 'Lunch Thursday?',
          ask: 'There is a new place by the station that does a proper set lunch. Thursday at 12:30?',
          answer: 'Thursday works. I will meet you there.',
        },
        {
          subject: 'Coffee this week?',
          ask: 'I am near your office on Wednesday. Coffee at 10 at the corner place?',
          answer: 'Wednesday at 10 is good. I will save us a table.',
        },
        {
          subject: 'Dinner on Friday?',
          ask: 'A few of us are going to the noodle bar on Friday at 7. Want to come?',
          answer: 'Count me in for Friday. I might be ten minutes late.',
        },
        {
          subject: 'Lunch next week?',
          ask: 'It has been ages. Could you do lunch on Tuesday, somewhere near you?',
          answer: 'Tuesday is perfect. There is a good soup place across the street.',
        },
        {
          subject: 'Breakfast before the trip?',
          ask: 'Breakfast at the bakery on Saturday at 8, before we head out?',
          answer: 'Saturday at 8 works. I will bring the maps.',
        },
        {
          subject: 'Drinks after work?',
          ask: 'The terrace by the river opens again on Thursday. Drinks after work?',
          answer: 'Thursday by the river sounds great. See you around 6.',
        },
        {
          subject: 'A walk on Sunday?',
          ask: 'The weather looks good for Sunday. A walk along the canal, and lunch after?',
          answer: 'Yes to Sunday. I will meet you at the bridge at 11.',
        },
      ],
      c,
    );
    return {
      subject,
      cast: [person(2, c)],
      steps: [
        { from: 0, plain: true, text: `${ask}\n\n${person(2, c).name}` },
        {
          from: 'me',
          quotes: true,
          draft: true,
          // How the answer opens turns at its own rate, so the same plan never gets the same answer.
          text: `${rotate(['', 'Sounds good. ', 'Yes, please. ', 'Perfect. ', 'Great idea. '], c)}${answer}`,
        },
      ],
    };
  },

  weekly: (c) => {
    const issue = 212 - c;
    const topic = rotate(
      [
        'what QUIC changed',
        'the cost of a syscall',
        'schedulers, again',
        'memory you did not ask for',
      ],
      c,
    );
    return {
      subject: issue > 0 ? `Issue ${issue}: ${topic}` : `Kernel Weekly: ${topic}`,
      cast: [{ name: 'Kernel Weekly', email: 'hello@kernelweekly.example.com' }],
      list: {
        name: 'Kernel Weekly',
        id: 'weekly.kernelweekly.example.com',
        unsubscribe:
          '<https://kernelweekly.example.com/unsubscribe?u=demo>, <mailto:leave@kernelweekly.example.com>',
      },
      steps: [
        {
          from: 0,
          unread: true,
          text: newsletterText(topic),
          html: () => newsletterHtml(topic, c),
        },
      ],
    };
  },

  trip: (c) => {
    const trip = rotate(
      [
        {
          subject: "Ridge trip: who's bringing what",
          date: '14th',
          bring: 'the tent and the water filter',
          take: 'the stove and fuel',
          ask: 'bear canister',
          have: 'canister',
          food: 'breakfast for both mornings',
          forecast: 'clear until Sunday afternoon',
          off: 'ridge',
          by: 'noon',
          map: 'trail map',
          past: 'lake',
        },
        {
          subject: 'Camping weekend plan',
          date: '21st',
          bring: 'the big tent and the first-aid kit',
          take: 'the cook set and the gas',
          ask: 'water filter',
          have: 'filter',
          food: 'lunch for the first day',
          forecast: 'rain on Saturday night and dry after',
          off: 'campsite',
          by: 'ten',
          map: 'route',
          past: 'last village',
        },
        {
          subject: 'Hut trip packing list',
          date: '6th',
          bring: 'the rope and the hut booking',
          take: 'the stove and two pots',
          ask: 'spare tarp',
          have: 'tarp',
          food: 'dinner for the first night',
          forecast: 'snow above the hut until Saturday',
          off: 'hut',
          by: 'eleven',
          map: 'hut directions',
          past: 'car park',
        },
      ],
      c,
    );
    // Where and when I meet everyone turn at their own rates, so my replies differ for months.
    const meet = rotate(['station', 'bakery', 'library', 'market'], c);
    const time = rotate(['7', '6:30', '8', '7:30', '6'], c);
    const spare = rotate(
      ['headlamp', 'sleeping mat', 'rain shell', 'pair of poles', 'stove lighter'],
      c,
    );
    return {
      subject: trip.subject,
      cast: [person(1, c), person(3, c), person(4, c)],
      group: true,
      steps: [
        {
          from: 0,
          text: `Trip is on for the ${trip.date}. Let us split the gear so nobody carries two stoves. I can bring ${trip.bring}.`,
        },
        { from: 1, text: `I will take ${trip.take}. Who has the ${trip.ask}?` },
        {
          from: 'me',
          text: `I have the ${trip.have} and a spare ${spare}. I can drive from the ${meet} at ${time}.`,
        },
        { from: 2, text: `Count me in for the car. I will bring ${trip.food}.` },
        {
          from: 0,
          text: `Perfect. The forecast says ${trip.forecast}, so let us be off the ${trip.off} by ${trip.by}.`,
        },
        {
          from: 1,
          text: `${capital(trip.by)} works. I will print the ${trip.map}, since there is no signal past the ${trip.past}.`,
        },
        { from: 'me', text: `Great. See you all at ${time} at the ${meet}.` },
      ],
    };
  },

  // A draft to a host the demo's mail server can't reach on the first try, so sending it shows how
  // the Outbox holds a refused message and sends it on Retry.
  cabin: (c) => {
    const [from, to] = rotate(
      [
        ['21st', '23rd'],
        ['4th', '6th'],
        ['12th', '14th'],
        ['27th', '29th'],
        ['8th', '10th'],
        ['15th', '17th'],
        ['1st', '3rd'],
      ],
      c,
    );
    const party = rotate(
      ['Two adults and a dog.', 'Four adults, no pets.', 'Two adults and two children.'],
      c,
    );
    return {
      subject: rotate(['Cabin for the long weekend', 'Booking the cabin', 'Cabin dates'], c),
      cast: [{ name: 'Rae Holm', email: `bookings@${UNREACHABLE}` }],
      steps: [
        {
          from: 'me',
          draft: true,
          plain: true,
          text: `Hi Rae, is the cabin free from the ${from} to the ${to}? ${party}\n\nSam`,
        },
      ],
    };
  },

  // Junk, as any mailbox gathers it: each kind comes round every sixth cycle, and what it names
  // every seventh, so no two are alike.
  parcel: (c) => {
    const pick = <T>(items: readonly T[]) => rotate(items, c);
    const prize = pick([
      'a tablet',
      'a gift card',
      'a weekend away',
      'new headphones',
      'a coffee machine',
      'a smart watch',
      'an e-reader',
    ]);
    const place = pick(['Lagos', 'Minsk', 'Lima', 'Hanoi', 'Quito', 'Riga', 'Accra']);
    const gain = pick(['4,180', '3,960', '5,020', '2,870', '6,340', '3,310', '4,770']);
    const due = pick(['389.00', '1,240.50', '96.20', '512.75', '2,048.00', '77.90', '640.10']);
    const full = pick(['96', '98', '97', '99', '95', '93', '94']);
    const when = pick([
      'today',
      'this morning',
      'yesterday',
      'on Monday',
      'twice this week',
      'this afternoon',
      'on Friday',
    ]);
    const { subject, sender, text } = rotate(
      [
        {
          subject: 'Your parcel is waiting',
          sender: { name: 'Parcel Service', email: 'notice@parcel-delivery.example.net' },
          text: `We tried to deliver your parcel ${when}. Confirm your address within 24 hours to arrange a new delivery.`,
        },
        {
          subject: `You have won ${prize}`,
          sender: { name: 'Rewards Team', email: 'prizes@lucky-draw.example.biz' },
          text: `Congratulations! Your address was drawn to receive ${prize}. Claim it before midnight by confirming your details.`,
        },
        {
          subject: `Sign-in attempt from ${place}`,
          sender: { name: 'Account Security', email: 'alert@account-verify.example.net' },
          text: `We blocked a sign-in to your mailbox from ${place}. Verify your account within 48 hours or it will be suspended.`,
        },
        {
          subject: `$250 became $${gain} this week`,
          sender: { name: 'Coin Desk Pro', email: 'growth@moonshot-coins.example.org' },
          text: `Our trading bot turned $250 into $${gain} for people like you this week. Reply YES to activate your account.`,
        },
        {
          subject: `Payment of $${due} overdue`,
          sender: { name: 'Billing Department', email: 'billing@invoice-center.example.com' },
          text: `Your payment of $${due} is overdue. Open the invoice to avoid a late fee.`,
        },
        {
          subject: `Your mailbox is ${full}% full`,
          sender: { name: 'Mailbox Storage', email: 'quota@mail-storage.example.net' },
          text: `Your mailbox is ${full}% full, and new mail will be held until you upgrade. Upgrade within 24 hours to keep receiving messages.`,
        },
      ],
      c,
    );
    return { subject, cast: [sender], folder: 'Junk', steps: [{ from: 0, text }] };
  },

  release: (c) => {
    // One release a cycle, counting back from 0.4: 0.3.9, 0.3.8 and on to 0.3, then 0.2.9.
    const back = 40 - c;
    const version =
      back > 0 ? `0.${Math.floor(back / 10)}${back % 10 ? `.${back % 10}` : ''}` : 'preview';
    return {
      subject: `Toy Box ${version} release notes`,
      cast: [person(8, c)],
      folder: 'Projects',
      steps: [
        {
          from: 0,
          text: `Here is the draft of the release notes. Could you check the ${rotate(['upgrade section', 'list of fixes', 'known issues', 'thanks section'], c)} before ${rotate(['Friday', 'Monday', 'Wednesday', 'the release', 'Thursday'], c)}?`,
        },
      ],
    };
  },

  // What one shop sends about each order, which goes straight to Trash.
  shipped: (c) => {
    const order = `#${(482_130 + c * 7_919) % 1_000_000}`;
    const { subject, text } = rotate(
      [
        {
          subject: 'Your order has shipped',
          text: `Good news: ${c === 0 ? 'your order' : `order ${order}`} is on its way and should arrive within three days.`,
        },
        {
          subject: 'Your order was delivered',
          text: `Order ${order} was left at your front door this afternoon.`,
        },
        {
          subject: 'How did we do?',
          text: `Tell us what you think of order ${order}. It takes a minute, and every review helps.`,
        },
        {
          subject: 'Your return was received',
          text: `We received the return for order ${order}. Your refund will reach your card within five days.`,
        },
        {
          subject: 'Your receipt',
          text: `Thank you for order ${order}. Your receipt is below, and we will write again when it ships.`,
        },
      ],
      c,
    );
    return {
      subject,
      cast: [{ name: 'Orders', email: 'orders@shop.example.com' }],
      list: { name: 'Shop orders', id: 'orders.shop.example.com', unsubscribe: `<${BUSY_LIST}>` },
      folder: 'Trash',
      steps: [{ from: 0, text }],
    };
  },

  invoice: (c) => {
    const month = MONTH_NAMES[(((9 - c) % 12) + 12) % 12]!;
    const number = `INV-${2071 - (c % 2000)}`;
    return {
      subject: `Invoice for ${month}`,
      cast: [{ name: 'Fieldnote Studio', email: 'billing@fieldnote.example.com' }],
      filed: 'Receipts',
      steps: [
        {
          from: 0,
          unread: true,
          text: `Invoice ${number} is ready. Payment is due within 14 days.\n\nThe PDF is attached. Thank you for working with us.`,
          files: () => [
            { name: `${number}.pdf`, type: 'application/pdf', content: invoicePdf(number) },
          ],
        },
      ],
    };
  },

  review: (c) => {
    const { subject, when, notes, after } = rotate(
      [
        {
          subject: 'Design review notes',
          when: 'today’s',
          notes: [
            'Keep the list rows one fixed height',
            'Stamps mark the account in unified views',
            'The reader opens on the newest message',
          ],
          after: 'I will turn these into issues tomorrow.',
        },
        {
          subject: 'Notes from the review',
          when: 'this morning’s',
          notes: [
            'Search shows matches as it is typed',
            'Undo send waits ten seconds',
            'The composer saves a draft at every pause',
          ],
          after: 'Shout if I missed anything.',
        },
        {
          subject: 'Review follow-ups',
          when: 'Tuesday’s',
          notes: [
            'Check contrast on every screen in both themes',
            'Give every target 44 pixels under a finger',
            'Write down which keys the sidebar takes',
          ],
          after: 'I will check in on these on Friday.',
        },
      ],
      c,
    );
    return {
      subject,
      cast: [person(5, c)],
      steps: [
        {
          from: 0,
          flagged: true,
          text: [
            `Notes from ${when} review:`,
            '',
            ...notes.map((note) => `- ${note}`),
            '',
            after,
          ].join('\n'),
        },
      ],
    };
  },

  q4: (c) => {
    const { quarter, by, first, others, design, share, kickoff } = rotate(
      [
        {
          quarter: 'Q4',
          by: 'Wednesday',
          first: 'the sync rewrite',
          others: 'the on-call handover, and the billing export',
          design: 'mobile layout',
          share: 'Friday',
          kickoff: 'Monday',
        },
        {
          quarter: 'Q3',
          by: 'Tuesday',
          first: 'the search index',
          others: 'the support rota, and the data export',
          design: 'settings screens',
          share: 'Thursday',
          kickoff: 'Wednesday',
        },
        {
          quarter: 'Q2',
          by: 'Thursday',
          first: 'the push service',
          others: 'the hiring loop, and the audit log',
          design: 'onboarding flow',
          share: 'Monday',
          kickoff: 'Tuesday',
        },
        {
          quarter: 'Q1',
          by: 'Friday',
          first: 'the outbox',
          others: 'the incident review, and the price change',
          design: 'dark theme',
          share: 'Wednesday',
          kickoff: 'Thursday',
        },
      ],
      c,
    );
    return {
      subject: `${quarter} planning`,
      cast: [person(7, c), person(6, c), person(5, c)],
      group: true,
      steps: [
        {
          from: 0,
          text: `Let us settle the plan this week. Please add your top three priorities to the doc by ${by}.`,
        },
        { from: 1, text: `Mine are in: ${first}, ${others}.` },
        {
          from: 'me',
          text: `Added mine. ${capital(first)} overlaps with yours, so I merged them into one line.`,
        },
        {
          from: 2,
          text: `Design needs a week for the ${design} before anything ships. Can we put that first?`,
        },
        {
          from: 0,
          text: `Agreed. ${capital(design)} first, then ${first}. I will share the final plan on ${share}.`,
        },
        { from: 1, unread: true, text: `Sounds right. I will set up the kickoff for ${kickoff}.` },
      ],
    };
  },

  standup: (c) => {
    const { subject, text } = rotate(
      [
        {
          subject: 'Standup moved to 10:00',
          text: 'Tomorrow’s standup moves to 10:00 so we can join the vendor call at 9.',
        },
        {
          subject: 'Standup moved to 9:30',
          text: 'Tomorrow’s standup moves to 9:30, since the room is booked from 10.',
        },
        {
          subject: 'No standup on Friday',
          text: 'No standup on Friday, because of the offsite. Post your update in the channel instead.',
        },
        {
          subject: 'Standup moved to 11:00',
          text: 'Tomorrow’s standup moves to 11:00, so the new starters can join after their first session.',
        },
      ],
      c,
    );
    return { subject, cast: [person(6, c)], steps: [{ from: 0, plain: true, text }] };
  },

  offsite: (c) => {
    const [event, topic] = rotate(
      [
        ['offsite', 'mobile layout'],
        ['kickoff', 'search index'],
        ['team day', 'onboarding flow'],
      ],
      c,
    );
    return {
      subject: `${capital(event)} agenda`,
      cast: [person(7, c), person(5, c), person(6, c)],
      steps: [
        {
          from: 'me',
          draft: true,
          // Another client's draft, which only Trail Mix's editor can turn back into Markdown.
          htmlOnly: true,
          html: () =>
            `<div dir="ltr">Draft agenda for the <b>${event}</b>:<ul><li>Morning: walk through <a href="https://example.org/plan">the plan</a></li><li>Lunch</li><li>Afternoon: review the <i>${topic}</i></li></ul></div>`,
          text: [
            `Draft agenda for the ${event}:`,
            '',
            '- Morning: walk through the plan',
            '- Lunch',
            `- Afternoon: review the ${topic}`,
          ].join('\n'),
        },
      ],
    };
  },
};

/** Each account's cycle, newest first: a story and which of its steps. A reply is always newer. */
const LAYOUT: Record<DemoKind, [story: string, step: number][]> = {
  personal: [
    ['plan', 2],
    ['pr412', 1],
    ['pr412', 0],
    ['lunch', 1],
    ['photos', 0],
    ['weekly', 0],
    ['pr409', 0],
    ['lunch', 0],
    ['plan', 1],
    ['trip', 6],
    ['trip', 5],
    ['release', 0],
    ['trip', 4],
    ['trip', 3],
    ['parcel', 0],
    ['trip', 2],
    ['trip', 1],
    ['trip', 0],
    ['plan', 0],
    ['shipped', 0],
    ['cabin', 0],
  ],
  work: [
    ['q4', 5],
    ['invoice', 0],
    ['offsite', 0],
    ['review', 0],
    ['q4', 4],
    ['standup', 0],
    ['q4', 3],
    ['q4', 2],
    ['q4', 1],
    ['q4', 0],
  ],
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function roleFolders(): { path: string; role: FolderRole }[] {
  return [
    { path: 'INBOX', role: 'inbox' },
    { path: 'Drafts', role: 'drafts' },
    { path: 'Sent', role: 'sent' },
    { path: 'Archive', role: 'archive' },
    { path: 'Trash', role: 'trash' },
    { path: 'Junk', role: 'junk' },
  ];
}

// Dates. The newest cycle spreads over a few weeks, closest together at the top, and everything
// older is spaced evenly back to within a year, so a twelve-month window holds the whole mailbox.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RECENT = 20;

/** When the seeded message with this UID arrived, in milliseconds, to the second. */
export function seededTime(size: number, createdAt: string, uid: number): number {
  const rank = size - uid;
  const recent = (r: number) => 25 * MINUTE * 1.45 ** r;
  let age = recent(rank);
  if (rank >= RECENT) {
    const room = 320 * DAY - recent(RECENT - 1);
    const step = Math.min(12 * 60 * MINUTE, room / Math.max(1, size - RECENT));
    const jitter = (seededRandom(rank)() - 0.5) * 0.8 * step;
    age = recent(RECENT - 1) + (rank - RECENT + 1) * step + jitter;
  }
  return Math.floor((Date.parse(createdAt) - age) / 1000) * 1000;
}

function dateOf(rank: number, size: number, createdAt: string): string {
  return new Date(seededTime(size, createdAt, size - rank)).toISOString();
}

// Bodies

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function quote(text: string, author: Address, date: string): string {
  const when = new Date(date);
  const time = `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
  const day = `${DAY_NAMES[when.getUTCDay()]}, ${when.getUTCDate()} ${MONTH_NAMES[when.getUTCMonth()]!.slice(0, 3)} ${when.getUTCFullYear()}`;
  const quoted = text.split('\n').map((line) => (line ? `> ${line}` : '>'));
  return `\n\nOn ${day} at ${time}, ${author.name ?? author.email} wrote:\n${quoted.join('\n')}`;
}

/** Paragraphs, lists, indented code and quotes, as a mail client would send them. */
function htmlOf(text: string): string {
  const blocks = text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith('- '))) {
      return `<ul>${lines.map((line) => `<li>${escape(line.slice(2))}</li>`).join('')}</ul>`;
    }
    if (lines.every((line) => line.startsWith('    '))) {
      return `<pre><code>${escape(lines.map((line) => line.slice(4)).join('\n'))}</code></pre>`;
    }
    const quoteAt = lines.findIndex((line) => line.startsWith('>'));
    if (quoteAt > 0 && lines.slice(quoteAt).every((line) => line.startsWith('>'))) {
      const inner = lines
        .slice(quoteAt)
        .map((line) => line.replace(/^> ?/, ''))
        .join('\n');
      const attribution = lines.slice(0, quoteAt).map(escape).join('<br>');
      return `<p>${attribution}</p><blockquote type="cite">${htmlOf(inner)}</blockquote>`;
    }
    return `<p>${lines.map(escape).join('<br>')}</p>`;
  });
  return `<div dir="auto">${blocks.join('\n')}</div>`;
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function newsletterText(topic: string): string {
  return [
    `This week: ${topic}, connection migration in practice, and a long read on congestion control.`,
    '',
    'Connection migration in practice',
    'A phone that moves from Wi-Fi to cellular keeps its QUIC connection, because the connection is named by an ID rather than by an address. The catch is in the middle boxes that still expect the old way.',
    '',
    'A long read on congestion control',
    'Why a slow start is not slow, and how the congestion window grows back after a loss. The second half is a careful tour of pacing.',
    '',
    'You are receiving this because you subscribed to Kernel Weekly.',
  ].join('\n');
}

/**
 * A newsletter with a style sheet, nested tables, inline styles on every element and a remote
 * image per article. The newest issue runs to about 300 KB, as the heaviest real ones do, since the
 * reader's budget is measured on it. Older issues run to about 10 KB.
 */
function newsletterHtml(topic: string, cycle: number): string {
  const random = seededRandom(cycle + 1);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const text = "font-family:Georgia,'Times New Roman',serif;color:#1d2b3a";
  const paragraph = `margin:0 0 14px;font-size:16px;line-height:1.6;${text}`;
  const heading = `margin:0 0 10px;font-size:20px;line-height:1.3;font-weight:bold;${text}`;
  const article = (title: string, body: string[], i: number) =>
    `<tr><td class="article" style="padding:24px 32px;border-top:1px solid #e4dccb;background:#fdf6e3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="figure" width="160" valign="top" style="padding:0 20px 0 0"><img src="https://kernelweekly.example.com/img/${cycle}/${i}.png" width="160" height="100" alt="" style="display:block;border:0;border-radius:6px"></td>
<td valign="top"><h2 style="${heading}">${escape(title)}</h2>
${body.map((sentences) => `<p style="${paragraph}">${escape(sentences)}</p>`).join('\n')}
<p style="margin:0;font-size:14px;${text}"><a href="https://kernelweekly.example.com/r/${cycle}/${i}" style="color:#2a5d8f;text-decoration:underline">Read the whole piece</a></p>
</td></tr></table></td></tr>`;

  const articles = [
    article(
      'Connection migration in practice',
      [
        'A phone that moves from Wi-Fi to cellular keeps its QUIC connection, because the connection is named by an ID rather than by an address. The catch is in the middle boxes that still expect the old way.',
      ],
      0,
    ),
    article(
      'A long read on congestion control',
      [
        'Why a slow start is not slow, and how the congestion window grows back after a loss. The second half is a careful tour of pacing.',
      ],
      1,
    ),
  ];
  const length = cycle === 0 ? 294_000 : 8_000;
  for (let i = 2, size = 0; size < length; i++) {
    const body = Array.from({ length: 3 }, () =>
      Array.from({ length: 4 }, () => pick(SENTENCES)).join(' '),
    );
    const next = article(pick(TITLES), body, i);
    articles.push(next);
    size += next.length;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Kernel Weekly</title>
<style>
body { margin: 0; padding: 0; background: #1d2b3a; }
.article h2 a { color: inherit; text-decoration: none; }
@media (max-width: 600px) {
  .wrapper { width: 100% !important; }
  .article { padding: 16px !important; }
  .figure { display: none !important; }
}
</style></head>
<body style="margin:0;padding:0;background:#1d2b3a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#1d2b3a" style="background:#1d2b3a"><tr><td align="center" style="padding:24px">
<table class="wrapper" role="presentation" width="640" cellpadding="0" cellspacing="0" bgcolor="#fdf6e3" style="background:#fdf6e3;border-radius:8px">
<tr><td><img src="https://kernelweekly.example.com/masthead.png" width="640" height="140" alt="Kernel Weekly" style="display:block;border:0"></td></tr>
<tr><td style="padding:24px 32px"><h1 style="margin:0 0 12px;font-size:28px;line-height:1.25;${text}">This week: ${escape(topic)}</h1>
<p style="${paragraph}">Plus connection migration in practice, a long read on congestion control, and the rest of the week in systems.</p></td></tr>
${articles.join('\n')}
<tr><td style="padding:24px 32px;font-size:12px;line-height:1.5;color:#5b6b7a;font-family:Helvetica,Arial,sans-serif">You are receiving this because you subscribed to Kernel Weekly. <a href="https://kernelweekly.example.com/unsubscribe?u=demo" style="color:#5b6b7a">Unsubscribe</a></td></tr>
</table></td></tr></table>
<img src="https://kernelweekly.example.com/open/${cycle}.gif" width="1" height="1" alt="">
</body></html>`;
}

const TITLES = [
  'What the scheduler does while you wait',
  'Page tables, briefly',
  'The hidden cost of a context switch',
  'Reading a flame graph without fooling yourself',
  'Why your fsync is slower than you think',
  'Allocators that never give memory back',
  'A tour of io_uring',
  'Timers, ticks and tickless kernels',
  'Lock-free is not wait-free',
  'Where the TLB misses go',
];

const SENTENCES = [
  'The interesting part is not the fast path but what happens when it is missed.',
  'Most of the time is spent waiting, and the measurements are honest about it.',
  'A benchmark that fits in the cache tells you about the cache, not the program.',
  'The fix was three lines, and finding them took two weeks.',
  'Every layer adds a queue, and every queue adds a place for latency to hide.',
  'Batching helps until the batch is the thing everyone is waiting for.',
  'The kernel already knew; the program simply never asked.',
  'Copying memory is cheap until it is the only thing the machine is doing.',
  'A good trace answers the question you did not know to ask.',
  'Under load, the slowest machine sets the pace for everyone.',
  'The default was chosen in 1998, and nobody has measured it since.',
  'Contention looks like slowness from the outside and like waiting from the inside.',
];

// Attachments are generated, so the repository holds no binary files. Each is made once.

const RIDGE = once(() => picture(0.58, 0.12));
const LAKE = once(() => picture(0.62, 0.55));

function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

/** A small landscape: sky over a ridge, in the given hues. */
function picture(sky: number, land: number): Uint8Array {
  const width = 160;
  const height = 100;
  return png(width, height, (x, y) => {
    const ridge = height * (0.55 + 0.15 * Math.sin(x / 17) + 0.05 * Math.sin(x / 5));
    const shade = y / height;
    return y < ridge ? hsl(sky, 0.5, 0.75 - shade * 0.3) : hsl(land, 0.35, 0.45 - shade * 0.2);
  });
}

function hsl(hue: number, saturation: number, lightness: number): [number, number, number] {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue * 12) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

/** An RGB PNG whose image data is stored without compression, which every decoder reads. */
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const stride = width * 3 + 1;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * stride + 1 + x * 3);
  }
  const stored: number[] = [0x78, 0x01];
  for (let at = 0; at < rows.length; at += 0xffff) {
    const block = rows.subarray(at, at + 0xffff);
    const final = at + 0xffff >= rows.length ? 1 : 0;
    const n = block.length;
    stored.push(final, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff);
    for (const byte of block) stored.push(byte);
  }
  let a = 1;
  let b = 0;
  for (const byte of rows) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  stored.push(...uint32(b * 65536 + a));
  return new Uint8Array([
    ...[137, 80, 78, 71, 13, 10, 26, 10],
    ...chunk('IHDR', [...uint32(width), ...uint32(height), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', stored),
    ...chunk('IEND', []),
  ]);
}

function chunk(type: string, data: number[]): number[] {
  const body = [...type].map((char) => char.charCodeAt(0)).concat(data);
  return [...uint32(data.length), ...body, ...uint32(crc32(body))];
}

function uint32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function crc32(bytes: number[]): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

/** A one-page PDF that says which invoice it is. */
function invoicePdf(number: string): Uint8Array {
  const text = `BT /F1 24 Tf 72 760 Td (Invoice ${number}) Tj 0 -36 Td /F1 12 Tf (Fieldnote Studio) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

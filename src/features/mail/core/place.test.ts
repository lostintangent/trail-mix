import { describe, expect, test } from 'bun:test';
import { conversationIdOf } from './conversations.ts';
import { bundleIdOf } from './github.ts';
import type { Place, View } from './model.ts';
import { addressOf, paramsOf, placeAt, placeOf, readQuery, writeQuery } from './place.ts';

const PERSONAL = '0b6f1c2e-6d0a-4a51-9f6e-1f4c3b2a9d10';
const WORK = 'f00dfeed-0000-4000-8000-000000000042';
/** A conversation of an account, as the index names one, with every part's encoding in it. */
const conversation = (account: string, root = '<CAF=1+x/y@mail.example.com>') =>
  conversationIdOf(account, 'inbox', root);
const bundle = (account: string) => bundleIdOf(account, 'TrailMix-Demo/toy.box_2');

const VIEWS: View[] = [
  { in: 'inbox' },
  { in: 'flagged' },
  { in: 'drafts' },
  { in: 'outbox' },
  { in: 'folder', folder: { account: PERSONAL, path: 'INBOX' } },
  { in: 'folder', folder: { account: PERSONAL, path: 'Projects/Toy Box' } },
  { in: 'folder', folder: { account: PERSONAL, path: '[Airmail]/Send Later' } },
  { in: 'folder', folder: { account: PERSONAL, path: 'a&b=c?d#e%f+g' } },
  { in: 'folder', folder: { account: PERSONAL, path: 'Reçus/Ελληνικά 📬' } },
  { in: 'search', text: 'lunch thu' },
  { in: 'search', text: 'from:ada@example.com & "q4 plan" 100%+' },
  { in: 'search', text: 'pacing', fullText: true },
];

describe('every place comes back from its address', () => {
  for (const view of VIEWS) {
    const opens =
      view.in === 'folder'
        ? [conversation(view.folder.account)]
        : [conversation(PERSONAL), conversation(WORK, 'plain')];
    for (const open of [undefined, ...opens]) {
      const place: Place = open === undefined ? { view } : { view, open };
      // An Inbox view holds a bundle of the account the conversation open is of.
      const account = view.in === 'folder' ? view.folder.account : PERSONAL;
      const lists =
        (view.in === 'inbox' || view.in === 'folder') && open !== conversation(WORK, 'plain');
      for (const each of lists ? [place, { ...place, bundle: bundle(account) }] : [place]) {
        test(addressOf(each), () => {
          expect(placeAt(addressOf(each))).toEqual(each);
          // As the router reads and writes it, and as a whole URL another device pastes.
          expect(placeOf(readQuery(writeQuery(paramsOf(each))))).toEqual(each);
          expect(placeAt(`https://trail-mix.example${addressOf(each)}`)).toEqual(each);
        });
      }
    }
  }
});

test('an address reads plainly, and the unified Inbox with nothing open is the root alone', () => {
  expect(addressOf({ view: { in: 'inbox' } })).toBe('/');
  expect(addressOf({ view: { in: 'drafts' } })).toBe('/?in=drafts');
  expect(
    addressOf({ view: { in: 'folder', folder: { account: WORK, path: 'Projects/Toy Box' } } }),
  ).toBe(`/?account=${WORK}&folder=Projects/Toy%20Box`);
  expect(addressOf({ view: { in: 'search', text: 'lunch thu', fullText: true } })).toBe(
    '/?q=lunch%20thu&bodies=1',
  );
});

test('an address that names nothing it can open reads as the unified Inbox with nothing open', () => {
  const inbox: Place = { view: { in: 'inbox' } };
  for (const address of [
    '/',
    '/?in=trash',
    '/?in=folder',
    '/?in=search',
    '/?in=',
    '/?nonsense=1',
    '/?open=not-a-conversation',
    `/?open=${encodeURIComponent(conversation(PERSONAL))}&in=archive`,
  ]) {
    expect({ address, place: placeAt(address) }).toEqual({ address, place: inbox });
  }
  expect(placeOf({ in: 1, q: ['lunch'], account: null })).toEqual(inbox);
});

test('a part of an address that doesn’t fit is left out, and the rest still opens', () => {
  const work: View = { in: 'folder', folder: { account: WORK, path: 'Receipts' } };
  // Half a folder, an empty search, and Bodies with no search are nothing.
  expect(placeAt(`/?account=${WORK}`)).toEqual({ view: { in: 'inbox' } });
  expect(placeAt('/?folder=Receipts&in=flagged')).toEqual({ view: { in: 'flagged' } });
  expect(placeAt('/?q=&bodies=1')).toEqual({ view: { in: 'inbox' } });
  // A folder can't hold another account's conversation, and a broken one is no conversation.
  expect(placeOf({ ...paramsOf({ view: work }), open: conversation(PERSONAL) })).toEqual({
    view: work,
  });
  expect(placeOf({ in: 'drafts', open: 'a:b' })).toEqual({ view: { in: 'drafts' } });
  // A bundle is listed only by an Inbox view, and holds its own account's conversations alone.
  expect(placeAt(`/?in=flagged&bundle=${bundle(PERSONAL)}`)).toEqual({ view: { in: 'flagged' } });
  expect(placeOf({ ...paramsOf({ view: work }), bundle: bundle(PERSONAL) })).toEqual({
    view: work,
  });
  expect(placeOf({ bundle: bundle(PERSONAL), open: conversation(WORK) })).toEqual({
    view: { in: 'inbox' },
    bundle: bundle(PERSONAL),
  });
  expect(placeOf({ bundle: 'personal:not-a-repository', open: conversation(WORK) })).toEqual({
    view: { in: 'inbox' },
    open: conversation(WORK),
  });
  // Only the first of a repeated parameter counts.
  expect(placeAt('/?in=flagged&in=drafts')).toEqual({ view: { in: 'flagged' } });
});

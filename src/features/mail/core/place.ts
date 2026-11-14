import { partsOf } from './conversations.ts';
import { bundlePartsOf } from './bundles.ts';
import type { AccountId, Place, View } from './model.ts';

/**
 * A place as an address, and back: the address is `/` and a query that names the view and the
 * conversation open in it. The unified Inbox with nothing open is `/` alone. Anything an address
 * can't mean reads as the unified Inbox with nothing open, and a conversation the view can't hold
 * is left out, so every address opens somewhere.
 *
 * - `/?in=flagged`, and the same for `drafts` and `outbox`
 * - `/?account=<id>&folder=<path>` for a folder
 * - `/?q=<text>` for a search, and `&bodies=1` when it reads message bodies too
 * - `&unread=1` after the unified Inbox or a folder that shows only its unread conversations, which
 *   for the unified Inbox is `/?unread=1`
 * - `&bundle=<bundle>` after the unified Inbox or a folder of the bundle's account, which an Inbox
 *   view lists
 * - `&open=<conversation>` after any of them, of the bundle's account when one is open
 */

/** An address's parameters, each at most once, in the order an address writes them. */
export type PlaceParams = Partial<Record<(typeof KEYS)[number], string>>;

const KEYS = ['in', 'account', 'folder', 'q', 'bodies', 'unread', 'bundle', 'open'] as const;
const UNIFIED = ['inbox', 'flagged', 'drafts', 'outbox'] as const;

const INBOX: Place = { view: { in: 'inbox' } };

/** A place's parameters, with nothing the place doesn't need. */
export function paramsOf({ view, bundle, open }: Place): PlaceParams {
  const params: PlaceParams =
    view.in === 'folder'
      ? { account: view.folder.account, folder: view.folder.path }
      : view.in === 'search'
        ? { q: view.text, ...(view.fullText ? { bodies: '1' } : {}) }
        : view.in === 'inbox'
          ? {}
          : { in: view.in };
  const unread = (view.in === 'folder' || view.in === 'inbox') && view.unread;
  return {
    ...params,
    ...(unread ? { unread: '1' } : {}),
    ...(bundle === undefined ? {} : { bundle }),
    ...(open === undefined ? {} : { open }),
  };
}

/** The place an address's parameters name, read forgivingly. */
export function placeOf(params: Readonly<Record<string, unknown>>): Place {
  const text = (key: (typeof KEYS)[number]) => {
    const value = params[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const view = viewOf(text);
  if (!view) return INBOX;
  // A folder holds its own account's conversations and bundle alone, and a bundle its account's
  // conversations, so whatever names another account is left out.
  const holds = (account: AccountId | undefined) =>
    account !== undefined && (view.in !== 'folder' || view.folder.account === account);
  const bundle = view.in === 'inbox' || view.in === 'folder' ? text('bundle') : undefined;
  const bundled = bundle === undefined ? undefined : bundlePartsOf(bundle)?.account;
  const open = text('open');
  const opened = open === undefined ? undefined : partsOf(open)?.account;
  const inBundle = bundle !== undefined && holds(bundled);
  const opens = open !== undefined && holds(opened) && (!inBundle || opened === bundled);
  return { view, ...(inBundle ? { bundle } : {}), ...(opens ? { open } : {}) };
}

function viewOf(text: (key: (typeof KEYS)[number]) => string | undefined): View | undefined {
  const [unified, account, folder, q] = [text('in'), text('account'), text('folder'), text('q')];
  if (q !== undefined) {
    return text('bodies') === '1'
      ? { in: 'search', text: q, fullText: true }
      : { in: 'search', text: q };
  }
  const unread = text('unread') === '1' ? ({ unread: true } as const) : {};
  if (account !== undefined && folder !== undefined) {
    return { in: 'folder', folder: { account, path: folder }, ...unread };
  }
  if (unified === undefined || unified === 'inbox') return { in: 'inbox', ...unread };
  return isUnified(unified) ? { in: unified } : undefined;
}

const isUnified = (name: string): name is (typeof UNIFIED)[number] =>
  (UNIFIED as readonly string[]).includes(name);

/** An address's query read into its parameters: the first of each, decoded. */
export function readQuery(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) params[key] ??= value;
  return params;
}

/**
 * Parameters written as an address's query, `?` and all, or nothing for none. Each value is
 * encoded as a URI component, but `/`, `:` and `@` are left as they are, as a query may hold them,
 * so a folder's path and a conversation reads as written.
 */
export function writeQuery(params: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(params).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${encodeURIComponent(key)}=${encodeValue(value)}`] : [],
  );
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

const encodeValue = (value: string) =>
  encodeURIComponent(value).replace(/%(2F|3A|40)/gi, (escape) => decodeURIComponent(escape));

/** The address of a place, from the root. */
export const addressOf = (place: Place): string => `/${writeQuery(paramsOf(place))}`;

/** The place an address names, whether a path and query or a whole URL. */
export const placeAt = (address: string): Place =>
  placeOf(readQuery(new URL(address, 'http://place.invalid').search));

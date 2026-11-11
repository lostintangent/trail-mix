import type {
  Account,
  AccountId,
  Address,
  ConversationId,
  Flags,
  FolderRef,
  FolderRole,
  MessageRef,
  View,
} from '../../mail/core/index.ts';
import type { Endpoint } from '../../providers/index.ts';
import type { AccountSetup, DraftUpload, FileBytes, SignInSetup } from '../client/contract.ts';
import { STAMPS } from './accounts.ts';

/**
 * What a browser sends, checked before the Mailroom acts on it. The Worker only lets through the
 * names of queries and commands, so every argument arrives here as whatever the browser chose to
 * send. Each check returns a fresh value of the expected shape, holding nothing else, or throws.
 */

export function accountOf(value: unknown): AccountId {
  if (typeof value !== 'string' || !value || value.length > 100)
    throw new TypeError('That isn’t an account.');
  return value;
}

export function refOf(value: unknown): MessageRef {
  const { account, path, uidValidity, uid } = record(value, 'a message');
  if (
    typeof account !== 'string' ||
    typeof path !== 'string' ||
    !isCount(uidValidity) ||
    !isCount(uid)
  ) {
    throw new TypeError('That isn’t a message.');
  }
  return { account, path, uidValidity, uid };
}

export function refsOf(value: unknown): MessageRef[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new TypeError('That isn’t a list of messages.');
  return value.map(refOf);
}

export function folderOf(value: unknown): FolderRef {
  const { account, path } = record(value, 'a folder');
  if (typeof account !== 'string' || typeof path !== 'string' || !path) {
    throw new TypeError('That isn’t a folder.');
  }
  return { account, path };
}

const ROLES: readonly FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk'];

export function destinationOf(value: unknown): FolderRef | FolderRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? (value as FolderRole)
    : folderOf(value);
}

export function viewOf(value: unknown): View {
  const view = record(value, 'a view');
  switch (view.in) {
    case 'folder':
      return { in: 'folder', folder: folderOf(view.folder) };
    case 'inbox':
    case 'flagged':
    case 'drafts':
    case 'outbox':
      return { in: view.in };
    case 'search':
      return {
        in: 'search',
        text: textOf(view.text, 'A search'),
        ...(view.fullText === true ? { fullText: true } : {}),
      };
    default:
      throw new TypeError('That isn’t a view.');
  }
}

/** A place in a list, with 0 the newest, or the start of the list when there is none. */
export function placeOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('That isn’t a place in a list.');
  }
  return value;
}

export function conversationOf(value: unknown): ConversationId {
  if (typeof value !== 'string' || !value || value.length > 1000) {
    throw new TypeError('That isn’t a conversation.');
  }
  return value;
}

/** A time to send at: an ISO 8601 instant with its offset, read as UTC. */
export function instantOf(value: unknown): string {
  const instant =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
      ? Date.parse(value)
      : Number.NaN;
  if (Number.isNaN(instant)) throw new TypeError('That isn’t a time, with its offset.');
  return new Date(instant).toISOString();
}

/** An Outbox entry's id. */
export function sendOf(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100) {
    throw new TypeError('That isn’t a send.');
  }
  return value;
}

const FLAGS: readonly (keyof Flags)[] = ['seen', 'flagged', 'answered', 'draft'];

export function flagsOf(value: unknown): Partial<Flags> {
  const change: Partial<Flags> = {};
  for (const [name, on] of Object.entries(record(value, 'a flag change'))) {
    if (!(FLAGS as readonly string[]).includes(name) || typeof on !== 'boolean') {
      throw new TypeError('Flags are seen, flagged, answered and draft, each on or off.');
    }
    change[name as keyof Flags] = on;
  }
  return change;
}

export function accountChangeOf(
  value: unknown,
): Partial<Pick<Account, 'name' | 'fromName' | 'stamp' | 'signature'>> {
  const { name, fromName, stamp, signature } = record(value, 'an account change');
  return {
    ...(name === undefined ? {} : { name: textOf(name, 'A name') }),
    ...(fromName === undefined ? {} : { fromName: lineOf(fromName, 'A name', 200) }),
    ...(stamp === undefined ? {} : { stamp: stampOf(stamp) }),
    ...(signature === undefined
      ? {}
      : { signature: textOf(signature, 'A signature', 10_000, true) }),
  };
}

export function setupOf(value: unknown): AccountSetup {
  const setup = record(value, 'an account');
  if (setup.provider === 'demo') return { provider: 'demo' };
  if (setup.provider !== 'imap')
    throw new TypeError('That isn’t an account Trail Mix can connect.');
  const named = { provider: 'imap', ...namedOf(setup) } as const;
  const password = textOf(setup.password, 'A password', 1000, false, false);
  if (setup.preset !== undefined && setup.preset !== 'zoho') {
    throw new TypeError('That isn’t a preset.');
  }
  const preset = setup.preset === 'zoho' ? ({ preset: 'zoho' } as const) : {};
  if (preset.preset && setup.imap === undefined && setup.smtp === undefined) {
    return { ...named, ...preset, password };
  }
  return {
    ...named,
    ...preset,
    imap: endpointOf(setup.imap),
    smtp: endpointOf(setup.smtp),
    password,
  };
}

/** What a sign-in is for: a new account that signs in at its vendor, or one signing in again. */
export function signInOf(value: unknown): SignInSetup | AccountId {
  if (typeof value === 'string') return accountOf(value);
  const setup = record(value, 'a sign-in');
  if (setup.preset !== 'outlook') {
    throw new TypeError('That account doesn’t sign in at its vendor.');
  }
  return { preset: 'outlook', ...namedOf(setup) };
}

/** What a member calls an account, its address, and the name its mail is from, if any. */
function namedOf(setup: Record<string, unknown>) {
  const name = textOf(setup.name, 'A name');
  const address = addressOf(setup.address);
  const fromName = setup.fromName === undefined ? '' : lineOf(setup.fromName, 'A name', 200);
  return { name, address, ...(fromName ? { fromName } : {}) };
}

/** A draft as the composer saved it, with its new files' bytes. */
export function draftOf(value: unknown): DraftUpload {
  const draft = record(value, 'a draft');
  if (!Array.isArray(draft.attachments) || draft.attachments.length > 100) {
    throw new TypeError('A draft’s attachments are a list.');
  }
  return {
    account: accountOf(draft.account),
    to: addressesOf(draft.to),
    cc: addressesOf(draft.cc),
    bcc: addressesOf(draft.bcc),
    subject: lineOf(draft.subject, 'A subject', 1000),
    markdown: textOf(draft.markdown, 'A draft', 1_000_000, true, false),
    ...(draft.inReplyTo === undefined ? {} : { inReplyTo: refOf(draft.inReplyTo) }),
    attachments: draft.attachments.map((attachment: unknown) => {
      const held = record(attachment, 'an attachment');
      if ('in' in held) {
        if (typeof held.id !== 'string' || !/^\d{1,4}$/.test(held.id)) {
          throw new TypeError('That isn’t an attachment of a message.');
        }
        return { in: refOf(held.in), id: held.id };
      }
      return {
        file: fileOf(held.file),
        ...(held.contentId === undefined ? {} : { contentId: contentIdOf(held.contentId) }),
      };
    }),
  };
}

/** A device's push endpoint, as a browser names the device it asks about or forgets. */
export function pushEndpointOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new TypeError('A device is named by its push endpoint.');
  }
  return value;
}

export function senderOf(value: unknown): string {
  return addressOf(value).toLowerCase();
}

/** A switch turned on or off. */
export function switchOf(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('That isn’t on or off.');
  return value;
}

function addressesOf(value: unknown): Address[] {
  if (!Array.isArray(value) || value.length > 500) throw new TypeError('Recipients are a list.');
  return value.map((entry: unknown) => {
    const { name, email } = record(entry, 'an address');
    return {
      ...(name === undefined || name === '' ? {} : { name: lineOf(name, 'A name', 200) }),
      email: addressOf(email),
    };
  });
}

function fileOf(value: unknown): FileBytes {
  const { name, type, content } = record(value, 'a file');
  if (!(content instanceof Uint8Array)) throw new TypeError('A file’s bytes didn’t arrive.');
  // A browser names a type it doesn’t know as '', and a form may add parameters such as a charset.
  const essence =
    (typeof type === 'string' ? type.split(';')[0]!.trim() : '') || 'application/octet-stream';
  if (typeof type !== 'string' || !/^[\w.+-]{1,100}\/[\w.+-]{1,100}$/.test(essence)) {
    throw new TypeError('That isn’t a file’s type.');
  }
  return { name: lineOf(name, 'A file’s name', 255), type: essence.toLowerCase(), content };
}

/** A Content-ID as the Markdown names it after `cid:`, without its angle brackets. */
function contentIdOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x3b\x3d\x3f-\x7e]{1,250}$/.test(value)) {
    throw new TypeError('That isn’t a Content-ID.');
  }
  return value;
}

/** Text on one line, as a header holds it. */
function lineOf(value: unknown, what: string, max: number): string {
  const line = textOf(value, what, max, true);
  if (/[\r\n\0]/.test(line)) throw new TypeError(`${what} is one line.`);
  return line;
}

function endpointOf(value: unknown): Endpoint {
  const { host, port, secure } = record(value, 'a host');
  if (
    typeof host !== 'string' ||
    !/^[a-z0-9.-]{1,253}$/i.test(host) ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    typeof secure !== 'boolean'
  ) {
    throw new TypeError(
      'Both hosts need a name, a port and whether they use TLS, unless a preset supplies them.',
    );
  }
  return { host, port, secure };
}

function stampOf(value: unknown) {
  const stamp = STAMPS.find((held) => held === value);
  if (!stamp) throw new TypeError('That isn’t a stamp color.');
  return stamp;
}

function addressOf(value: unknown): string {
  const address = textOf(value, 'An address', 320);
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new TypeError('That isn’t an email address.');
  return address;
}

function textOf(value: unknown, what: string, max = 1000, empty = false, trim = true): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${what} must be text.`);
  const text = trim ? value.trim() : value;
  if (!empty && !text) throw new TypeError(`${what} can’t be empty.`);
  return text;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 2 ** 32;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`That isn’t ${what}.`);
  }
  return value as Record<string, unknown>;
}

import {
  refOf,
  type AccountId,
  type Flags,
  type FolderRef,
  type FolderRole,
  type MessageRef,
  type Moved,
} from '../../mail/core/index.ts';
import type { MailProvider } from '../../providers/index.ts';
import type { BundleScope } from '../client/contract.ts';
import type { AccountBook } from './accounts.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
import type { SyncQueue } from './sync.ts';

/**
 * The member's commands on messages: flagging them and moving them, archive and delete included,
 * which are moves to a folder role. Each changes the server, account by account, and owes a sync
 * of every folder it touched, whose events the index then folds.
 */
export function messageCommands(ports: {
  book: Pick<AccountBook, 'get'>;
  store: Pick<EnvelopeIndex, 'bundled' | 'withRole'>;
  provider: (account: AccountId) => Promise<MailProvider>;
  sync: Pick<SyncQueue, 'folder'>;
  owe: (owing: () => void) => Promise<void>;
  /** Hears each message a move landed, so its arrival in an Inbox notifies no one. */
  movedIn: (ref: MessageRef) => void;
}) {
  const { store, sync } = ports;

  /** The messages a command names: those given, or those of a bundle that `bundled` picks. */
  const refsIn = (
    messages: MessageRef[] | BundleScope,
    bundled: (scope: BundleScope) => readonly MessageRef[],
  ): MessageRef[] => {
    const checked = input.messagesOf(messages);
    if (Array.isArray(checked)) return checked;
    return bundled(checked).map(refOf);
  };

  const byAccount = (refs: MessageRef[]) =>
    Map.groupBy(input.refsOf(refs), ({ account }) => {
      if (!ports.book.get(account)) throw new Error('There is no such account.');
      return account;
    });

  const pathWithRole = (account: AccountId, role: FolderRole) => {
    const folder = store.withRole(account, role);
    if (!folder) throw new Error(`That account has no ${role} folder.`);
    return folder.path;
  };

  return {
    async setFlags(
      messages: MessageRef[] | BundleScope,
      change: Partial<Flags>,
    ): Promise<MessageRef[]> {
      const checked = input.flagsOf(change);
      const refs = refsIn(messages, (scope) =>
        store
          .bundled(
            scope.bundle,
            scope.through,
            checked.seen === false || checked.flagged === true ? 'newest' : 'every',
          )
          .filter(({ flags }) =>
            Object.entries(checked).some(([flag, on]) => flags[flag as keyof Flags] !== on),
          ),
      );
      for (const [account, held] of byAccount(refs)) {
        await (await ports.provider(account)).setFlags(held, checked);
        await ports.owe(() => {
          for (const path of new Set(held.map((ref) => ref.path))) sync.folder({ account, path });
        });
      }
      return refs;
    },

    async move(messages: MessageRef[] | BundleScope, to: FolderRef | FolderRole): Promise<Moved[]> {
      const destination = input.destinationOf(to);
      const refs = refsIn(messages, (scope) => store.bundled(scope.bundle, scope.through, 'inbox'));
      const moved: Moved[] = [];
      for (const [account, held] of byAccount(refs)) {
        const path =
          typeof destination === 'string' ? pathWithRole(account, destination) : destination.path;
        const landed = await (await ports.provider(account)).move(held, path);
        for (const { to } of landed) ports.movedIn(to);
        moved.push(...landed);
        await ports.owe(() => {
          for (const from of new Set([...held.map((ref) => ref.path), path])) {
            sync.folder({ account, path: from });
          }
        });
      }
      return moved;
    },
  };
}

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import type { Folder } from '../../mail/core/index.ts';
import { foldersQuery, mailroom } from '../../mailroom/client/index.ts';
import { changed, isShown, type FolderChange } from '../core/changes.ts';

/**
 * How long a change the Mailroom accepted waits for a snapshot of the folders to show it, before
 * giving way anyway, as when another device changed the folder again.
 */
const SETTLED_MS = 10_000;

type Laid = { change: FolderChange; expiry?: ReturnType<typeof setTimeout> };

/**
 * The folder changes a browser lays over its folders while they reach the mail server. Each stays
 * until a snapshot shows it, so one fetched before the Mailroom listed the change can't undo it on
 * screen. A refused change is lifted at once, which is how the folders return as they were.
 */
class Laying {
  #laid: readonly Laid[] = [];
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  all = () => this.#laid;

  lay(change: FolderChange): Laid {
    const laid = { change };
    this.#set([...this.#laid, laid]);
    return laid;
  }

  lift(laid: Laid) {
    clearTimeout(laid.expiry);
    this.#set(this.#laid.filter((each) => each !== laid));
  }

  settle(laid: Laid) {
    laid.expiry = setTimeout(() => this.lift(laid), SETTLED_MS);
  }

  /** Lifts the changes a fresh snapshot already shows. */
  agreeWith(folders: readonly Folder[]) {
    const shown = this.#laid.filter(({ change }) => isShown(folders, change));
    for (const laid of shown) clearTimeout(laid.expiry);
    if (shown.length > 0) this.#set(this.#laid.filter((laid) => !shown.includes(laid)));
  }

  #set(laid: readonly Laid[]) {
    this.#laid = laid;
    for (const listener of this.#listeners) listener();
  }
}

const layings = new WeakMap<QueryClient, Laying>();

function layingOf(queryClient: QueryClient): Laying {
  let found = layings.get(queryClient);
  if (!found) layings.set(queryClient, (found = new Laying()));
  return found;
}

/** The folders as the member should see them: the Mailroom's snapshot with changes on their way. */
export function useChangedFolders(folders: readonly Folder[]): readonly Folder[] {
  const laying = layingOf(useQueryClient());
  const laid = useSyncExternalStore(laying.subscribe, laying.all);
  useEffect(() => laying.agreeWith(folders), [laying, folders]);
  return useMemo(
    () =>
      laid.length === 0
        ? folders
        : laid.reduce((held, { change }) => changed(held, change), [...folders]),
    [folders, laid],
  );
}

/** What a refusal says the member was doing: "Couldn't rename Trips." */
const doing = ({ do: what, folder }: FolderChange) => `${what} ${folder.name}`;

/**
 * Changes a folder on the mail server, showing the change at once. If the server refuses, the
 * folders return as they were and a toast says why. Resolves with whether the Mailroom accepted it.
 */
export function useFolderChange(): (change: FolderChange) => Promise<boolean> {
  const queryClient = useQueryClient();
  return useCallback(
    async (change) => {
      const laying = layingOf(queryClient);
      const laid = laying.lay(change);
      const { account, path } = change.folder;
      try {
        if (change.do === 'create') await mailroom.createFolder({ account, path });
        else if (change.do === 'rename') await mailroom.renameFolder({ account, path }, change.to);
        else await mailroom.deleteFolder({ account, path });
        laying.settle(laid);
        return true;
      } catch (error) {
        laying.lift(laid);
        void toast({ type: 'error', body: `Couldn’t ${doing(change)}. ${reasonOf(error)}` });
        void queryClient.invalidateQueries({ queryKey: foldersQuery.queryKey });
        return false;
      }
    },
    [queryClient],
  );
}

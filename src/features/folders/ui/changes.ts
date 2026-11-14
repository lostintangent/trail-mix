import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { layingsOf } from '../../../shared/laying.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import type { Folder } from '../../mail/core/index.ts';
import { foldersQuery, mailroom } from '../../mailroom/client/index.ts';
import { changed, isShown, type FolderChange } from '../core/changes.ts';

/** The folder changes a browser lays over its folders while they reach the mail server. */
const layingOf = layingsOf<FolderChange>();

/** The folders as the member should see them: the Mailroom's snapshot with changes on their way. */
export function useChangedFolders(folders: readonly Folder[]): readonly Folder[] {
  const laying = layingOf(useQueryClient());
  const laid = useSyncExternalStore(laying.subscribe, laying.all);
  useEffect(() => laying.agreeWith((change) => isShown(folders, change)), [laying, folders]);
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

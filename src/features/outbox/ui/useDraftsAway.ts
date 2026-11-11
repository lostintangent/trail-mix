import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { ConversationId, Folder, MessageRef, View } from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import { awayFromDrafts, draftsStillCounted, isDraftsView, notePeaks } from '../core/drafts.ts';
import type { Leaving } from '../core/leaving.ts';

/**
 * Mail on its way, kept out of Drafts as this device sees it: how many drafts on their way the
 * folders' counts still hold, and a view's rows without the conversations whose drafts are all on
 * their way, if it is a Drafts view. What each conversation holds is read from its last snapshot.
 * Places whose page hasn't arrived stay, and a row there is left out once it lands.
 */
export function useDraftsAway(all: readonly Leaving[], folders: readonly Folder[]) {
  const queryClient = useQueryClient();
  const drafts = useMemo(() => folders.filter(({ role }) => role === 'drafts'), [folders]);
  const countOf = useCallback(
    (draft: MessageRef) =>
      drafts.find(({ account, path }) => account === draft.account && path === draft.path)?.total,
    [drafts],
  );

  // Each send's Drafts folder is followed through every snapshot of the folders, in the render
  // that brings it.
  const [held, setHeld] = useState(() => ({ all, countOf, peaks: notePeaks([], all, countOf) }));
  const isNew = held.all !== all || held.countOf !== countOf;
  const peaks = isNew ? notePeaks(held.peaks, all, countOf) : held.peaks;
  if (isNew) setHeld({ all, countOf, peaks });
  const onTheirWay = draftsStillCounted(all, peaks, countOf);

  const withoutAway = useCallback(
    <Row extends { id: ConversationId } | undefined>(
      rows: readonly Row[] | undefined,
      view: View,
    ) => {
      if (!rows || !isDraftsView(view, drafts)) return rows;
      const away = awayFromDrafts(all, (conversation) =>
        queryClient
          .getQueryData(conversationQuery(conversation).queryKey)
          ?.filter((message) => countOf(message) !== undefined),
      );
      return away.size === 0 ? rows : rows.filter((row) => !row || !away.has(row.id));
    },
    [all, drafts, countOf, queryClient],
  );

  return { onTheirWay, withoutAway };
}

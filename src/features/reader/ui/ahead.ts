import type { QueryClient } from '@tanstack/react-query';
import type { ConversationId } from '../../mail/core/index.ts';
import { bodyQuery, conversationQuery } from '../../mailroom/client/index.ts';
import { refOf } from './refs.ts';

/**
 * Asks for a conversation the member is about to open, ahead of the click that opens it: its
 * messages, and with `body`, its newest message's body too, as a press on its row would want.
 */
export function askAhead(queryClient: QueryClient, id: ConversationId, { body = false } = {}) {
  void queryClient
    .fetchQuery(conversationQuery(id))
    .then((messages) => {
      if (!body) return;
      const sent = messages.filter(({ flags }) => !flags.draft);
      const newest = (sent.length ? sent : messages)
        .toSorted((a, b) => a.date.localeCompare(b.date))
        .at(-1);
      if (newest) void queryClient.prefetchQuery(bodyQuery(refOf(newest)));
    })
    .catch(() => {});
}

import type { QueryClient } from '@tanstack/react-query';
import { newestShown, refOf, type ConversationId } from '../../mail/core/index.ts';
import { bodyQuery, conversationQuery } from '../../mailroom/client/index.ts';

/**
 * Asks for a conversation the member is about to open, ahead of the click that opens it: its
 * messages, and with `body`, its newest message's body too, as a press on its row would want.
 */
export function askAhead(queryClient: QueryClient, id: ConversationId, { body = false } = {}) {
  void queryClient
    .fetchQuery(conversationQuery(id))
    .then((messages) => {
      if (!body) return;
      const newest = newestShown(messages);
      if (newest) void queryClient.prefetchQuery(bodyQuery(refOf(newest)));
    })
    .catch(() => {});
}

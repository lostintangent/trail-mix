import type { QueryClient } from '@tanstack/react-query';
import { Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { Command } from '../../commands/index.ts';
import { faceOf } from '../../conversations/index.ts';
import type { Account, Message } from '../../mail/core/index.ts';
import { accountsQuery, mailroom } from '../../mailroom/client/index.ts';
import { isLightPaper } from '../core/lightPaper.ts';

/**
 * Light paper in the browser. The Mailroom keeps the member's choice on the account, so every
 * device shows a sender's mail that way until it is turned off. It changes only the paper a
 * message's frame lies on, never the sanitized message.
 */

/** One choice of paper: a sender's mail on an account, on light paper or darkened. */
export type LightPaper = { account: Account['id']; sender: string; on: boolean };

/**
 * Chooses light paper for a sender on an account, or darkens their mail again. The account shows
 * it at once, and the accounts snapshot is refetched if the Mailroom refuses, so the change
 * visibly undoes itself.
 */
export function setLightPaper(queryClient: QueryClient, { account, sender, on }: LightPaper) {
  const address = sender.toLowerCase();
  queryClient.setQueryData(accountsQuery.queryKey, (accounts) =>
    accounts?.map((each) => {
      if (each.id !== account) return each;
      const others = each.lightPaperFrom.filter((email) => email !== address);
      return { ...each, lightPaperFrom: on ? [...others, address] : others };
    }),
  );
  mailroom.setLightPaper(account, address, on).catch(() => {
    void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
  });
}

/**
 * Light paper as a command, for the conversation open: it toggles the paper of the sender its row
 * shows, its newest who isn't the member. It is offered when a conversation is open in the dark
 * theme, where mail is darkened.
 */
export function lightPaperCommand(
  conversation: readonly Message[] | undefined,
  accounts: readonly Account[],
  selves: ReadonlySet<string>,
  choose: (choice: LightPaper) => void,
): Command {
  const sent = (conversation ?? [])
    .filter(({ flags }) => !flags.draft)
    .toSorted((a, b) => b.date.localeCompare(a.date));
  const sender = faceOf(
    sent.map(({ from }) => from),
    selves,
  )?.email;
  const account = accounts.find(({ id }) => id === sent[0]?.account);
  const isOn =
    account !== undefined && sender !== undefined && isLightPaper(sender, account.lightPaperFrom);
  return {
    id: 'message.lightPaper',
    title: 'Light paper for this sender',
    group: 'Message',
    icon: Sun,
    isChecked: isOn,
    isEnabled: account !== undefined && sender !== undefined,
    run: () => account && sender && choose({ account: account.id, sender, on: !isOn }),
  };
}

/** Whether the dark theme shows: chosen, or followed from the system's. */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(listen, isDark);
}

function isDark(): boolean {
  const chosen = document.documentElement.dataset['theme'];
  return chosen ? chosen === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function listen(changed: () => void): () => void {
  const system = matchMedia('(prefers-color-scheme: dark)');
  system.addEventListener('change', changed);
  const mode = new MutationObserver(changed);
  mode.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    system.removeEventListener('change', changed);
    mode.disconnect();
  };
}

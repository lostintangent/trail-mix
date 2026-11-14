import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Account } from '../../mail/core/index.ts';
import { accountsQuery, mailroom, outboxQuery } from '../../mailroom/client/index.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import { eraseSaid } from '../core/said.ts';

/**
 * The question before a member erases everything Trail Mix holds for them, which says what goes and
 * what stays. Cancel holds the focus. Once the Mailroom has erased it all, this device starts over
 * on the first-run screen at once, and every other device does on the Mailroom's hint.
 */
export function EraseQuestion({
  accounts,
  onClose,
}: {
  accounts: readonly Account[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: outgoing = [] } = useQuery(outboxQuery);
  const erase = useMutation({
    mutationFn: () => mailroom.eraseEverything(),
    // Offline it fails at once and says so, rather than waiting with its button spinning.
    networkMode: 'always',
    onSuccess: () => {
      queryClient.setQueryData(accountsQuery.queryKey, []);
      onClose();
    },
    onError: (error) =>
      void toast({ type: 'error', body: `Couldn’t erase everything. ${reasonOf(error)}` }),
  });
  return (
    <AlertDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && !erase.isPending && onClose()}
      title="Erase everything Trail Mix holds for you?"
      description={eraseSaid(accounts, outgoing.filter(({ state }) => state === 'waiting').length)}
      actionLabel="Erase everything"
      actionVariant="destructive"
      isActionLoading={erase.isPending}
      onAction={() => erase.mutate()}
    />
  );
}

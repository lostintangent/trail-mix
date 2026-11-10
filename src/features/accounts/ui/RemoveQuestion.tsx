import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useQueryClient } from '@tanstack/react-query';
import type { Account } from '../../mail/core/index.ts';
import { accountsQuery, mailroom } from '../../mailroom/client/index.ts';
import { toast } from '../../../shared/toasts.tsx';
import { removeSaid } from '../core/said.ts';

/**
 * The question before an account is removed, which says what goes with it. Once asked, the account
 * leaves the screen at once, and comes back with the Mailroom's reason if it refuses.
 */
export function RemoveQuestion({
  account,
  waiting,
  onRemoved,
  onClose,
}: {
  account: Account;
  /** How many of its messages wait in the Outbox. */
  waiting: number;
  onRemoved: (account: Account) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = async () => {
    queryClient.setQueryData(accountsQuery.queryKey, (held) =>
      held?.filter(({ id }) => id !== account.id),
    );
    onRemoved(account);
    try {
      await mailroom.removeAccount(account.id);
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
      const reason = error instanceof Error ? error.message : String(error);
      void toast({ type: 'error', body: `Couldn’t remove ${account.name}. ${reason}` });
    }
  };
  return (
    <AlertDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={`Remove ${account.name}?`}
      description={removeSaid(account, waiting)}
      actionLabel="Remove"
      actionVariant="destructive"
      onAction={() => {
        onClose();
        void remove();
      }}
    />
  );
}

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Account } from '../../mail/core/index.ts';
import { accountsQuery, mailroom } from '../../mailroom/client/index.ts';
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
  waiting,
  onClose,
}: {
  accounts: readonly Account[];
  /** How many messages wait in the Outbox. */
  waiting: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [isErasing, setErasing] = useState(false);
  const erase = async () => {
    setErasing(true);
    try {
      await mailroom.eraseEverything();
      queryClient.setQueryData(accountsQuery.queryKey, []);
      onClose();
    } catch (error) {
      setErasing(false);
      void toast({ type: 'error', body: `Couldn’t erase everything. ${reasonOf(error)}` });
    }
  };
  return (
    <AlertDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && !isErasing && onClose()}
      title="Erase everything Trail Mix holds for you?"
      description={eraseSaid(accounts, waiting)}
      actionLabel="Erase everything"
      actionVariant="destructive"
      isActionLoading={isErasing}
      onAction={() => void erase()}
    />
  );
}

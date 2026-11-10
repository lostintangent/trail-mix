import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { TextInput } from '@astryxdesign/core/TextInput';
import { spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useState, type FormEvent } from 'react';
import { toast } from '../../../shared/toasts.tsx';
import type { Folder } from '../../mail/core/index.ts';
import { mailroom } from '../../mailroom/client/index.ts';
import type { FolderQuestion } from './commands.ts';

/**
 * Creating, renaming or deleting a folder on the mail server. The folder list changes once the
 * Mailroom's next listing hints it, and if the server refuses, a toast says why.
 */
export function FolderDialog({
  question,
  onClose,
  onDeleted,
}: {
  question: FolderQuestion;
  onClose: () => void;
  /** Told when the folder is gone, as when it was the one in view. */
  onDeleted: (folder: Folder) => void;
}) {
  const [isWorking, setWorking] = useState(false);
  const attempt = async (doing: string, change: () => Promise<void>) => {
    setWorking(true);
    try {
      await change();
      onClose();
    } catch (error) {
      setWorking(false);
      const reason =
        error instanceof Error && error.message ? error.message : 'The mail server gave no reason.';
      void toast({ type: 'error', body: `Couldn't ${doing}. ${reason}` });
    }
  };

  if (question.ask === 'delete') {
    const { folder } = question;
    return (
      <AlertDialog
        isOpen
        onOpenChange={(isOpen) => !isOpen && onClose()}
        title={`Delete ${folder.name}?`}
        description="The folder and the mail in it are removed from the mail server."
        actionLabel="Delete"
        actionVariant="destructive"
        isActionLoading={isWorking}
        onAction={() =>
          attempt(`delete ${folder.name}`, async () => {
            await mailroom.deleteFolder({ account: folder.account, path: folder.path });
            onDeleted(folder);
          })
        }
      />
    );
  }
  return (
    <NameDialog question={question} isWorking={isWorking} onClose={onClose} attempt={attempt} />
  );
}

/** Naming a new folder, or a folder anew. */
function NameDialog({
  question,
  isWorking,
  onClose,
  attempt,
}: {
  question: Exclude<FolderQuestion, { ask: 'delete' }>;
  isWorking: boolean;
  onClose: () => void;
  attempt: (doing: string, change: () => Promise<void>) => Promise<void>;
}) {
  const isNew = question.ask === 'create';
  const [name, setName] = useState(isNew ? '' : question.folder.name);
  const title = isNew ? `New folder in ${question.account.name}` : `Rename ${question.folder.name}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    if (question.ask === 'create') {
      void attempt(`create ${wanted}`, () =>
        mailroom.createFolder({ account: question.account.id, path: wanted }),
      );
    } else {
      const { account, path, name: was } = question.folder;
      // A nested folder keeps its place: only the last part of its path changes.
      const to = `${path.slice(0, path.length - was.length)}${wanted}`;
      void attempt(`rename ${was}`, () => mailroom.renameFolder({ account, path }, to));
    }
  };
  return (
    <Dialog isOpen onOpenChange={(isOpen) => !isOpen && onClose()} width={360}>
      <form onSubmit={submit} {...stylex.props(styles.form)}>
        <Heading level={2}>{title}</Heading>
        <TextInput label="Name" value={name} onChange={setName} hasAutoFocus isRequired />
        <div {...stylex.props(styles.buttons)}>
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button
            label={isNew ? 'Create' : 'Rename'}
            type="submit"
            variant="primary"
            isLoading={isWorking}
          />
        </div>
      </form>
    </Dialog>
  );
}

const styles = stylex.create({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
  },
  buttons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: spacingVars['--spacing-2'],
  },
});

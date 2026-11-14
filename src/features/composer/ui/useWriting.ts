import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { addressesIn, type Account } from '../../mail/core/index.ts';
import { partUrl } from '../../mailroom/client/index.ts';
import { contentIdFor } from '../core/draft.ts';
import { addressText, sentFrom, type Attached, type Writing } from '../core/session.ts';
import type { Drafting } from './drafting.ts';

/** The address fields as the member types them, which the message reads as addresses. */
export type AddressText = Record<'to' | 'cc' | 'bcc', string>;

/**
 * The message being written, as the member changes it. Each change of theirs owes a save. The
 * composer's own changes don't: the editor settling the text it was given, and files named by the
 * draft that saved them.
 */
export function useWriting(drafting: Drafting, recipients: Pick<Writing, 'to' | 'cc'> | undefined) {
  const writing = useSyncExternalStore(drafting.subscribe, () => drafting.writing);
  const [typed, setTyped] = useState<AddressText>(() => ({
    to: addressText(writing.to),
    cc: addressText(writing.cc),
    bcc: addressText(writing.bcc),
  }));
  const fileUrl = useFileUrls();
  const hasEdited = useRef(false);

  const edit = (change: (was: Writing) => Partial<Writing>) => {
    drafting.write({ ...drafting.writing, ...change(drafting.writing) });
    drafting.owe();
    hasEdited.current = true;
  };

  // The parent's Reply-To arrives with its body. Until the member has chosen whom it's to, the
  // reply goes there instead. That alone is no change of theirs, so nothing saves for it, but once
  // they have written, the draft saved is the one sent, so it saves again to go where it says.
  const hasChosen = useRef(false);
  useEffect(() => {
    if (!recipients || hasChosen.current) return;
    setTyped((was) => ({ ...was, to: addressText(recipients.to), cc: addressText(recipients.cc) }));
    drafting.write({ ...drafting.writing, ...recipients });
    if (hasEdited.current) drafting.owe();
  }, [recipients, drafting]);

  return {
    writing,
    typed,
    /** What the editor holds, as the member writes it or as the editor settles what it was given. */
    write: (markdown: string, isEdit: boolean) => {
      if (isEdit) edit(() => ({ markdown }));
      else drafting.write({ ...drafting.writing, markdown });
    },
    address: (field: keyof AddressText, text: string) => {
      hasChosen.current = true;
      setTyped((was) => ({ ...was, [field]: text }));
      edit(() => ({ [field]: addressesIn(text) }));
    },
    sendFrom: (account: Account) => edit((was) => sentFrom(was, account)),
    setSubject: (subject: string) => edit(() => ({ subject })),
    /**
     * Takes files into the message: an image shown in the text, named by a Content-ID of its own,
     * or a file attached. Returns the images, for the editor to place.
     */
    take: (files: File[], inline: boolean) => {
      const added: Attached[] = files.map((file) =>
        inline && file.type.startsWith('image/')
          ? { file, contentId: contentIdFor(crypto.randomUUID()) }
          : { file },
      );
      edit((was) => ({ attachments: [...was.attachments, ...added] }));
      return added.filter((each): each is { file: File; contentId: string } => 'contentId' in each);
    },
    remove: (attached: Attached) =>
      edit((was) => ({ attachments: was.attachments.filter((each) => each !== attached) })),
    /** Where an image in the text shows from: a new file's bytes, or the saved draft's part. */
    imageUrl: (contentId: string) => {
      const found = writing.attachments.find((attached) => attached.contentId === contentId);
      if (!found) return undefined;
      return 'file' in found ? fileUrl(found.file) : partUrl(found.in, found.id);
    },
  };
}

/** Where each new file shows from while it is written, for as long as the composer is open. */
function useFileUrls() {
  const urls = useRef(new Map<File, string>());
  useEffect(() => {
    const made = urls.current;
    return () => {
      for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, []);
  return (file: File) => {
    let url = urls.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      urls.current.set(file, url);
    }
    return url;
  };
}

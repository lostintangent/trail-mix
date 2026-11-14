import { useEffect, useRef, useState } from 'react';
import { addressesIn, type Account } from '../../mail/core/index.ts';
import { partUrl } from '../../mailroom/client/index.ts';
import { contentIdFor } from '../core/draft.ts';
import { addressText, sentFrom, type Attached, type Writing } from '../core/session.ts';

/** The address fields as the member types them, which the message reads as addresses. */
export type AddressText = Record<'to' | 'cc' | 'bcc', string>;

/**
 * The message being written, as the member changes it. Each change of theirs counts in `edits`,
 * which autosave owes a save for. The composer's own changes don't count: the editor settling the
 * text it was given, and files named by the draft that saved them.
 */
export function useWriting(start: Writing, recipients: Pick<Writing, 'to' | 'cc'> | undefined) {
  const [writing, setWriting] = useState(start);
  const [edits, setEdits] = useState(0);
  const [typed, setTyped] = useState<AddressText>(() => ({
    to: addressText(start.to),
    cc: addressText(start.cc),
    bcc: addressText(start.bcc),
  }));
  const fileUrl = useFileUrls();

  const edit = (change: (was: Writing) => Partial<Writing>) => {
    setWriting((was) => ({ ...was, ...change(was) }));
    setEdits((count) => count + 1);
  };

  // The parent's Reply-To arrives with its body. Until the member has chosen whom it's to, the
  // reply goes there instead. That alone is no change of theirs, so nothing saves for it, but once
  // they have written, the draft saved is the one sent, so it saves again to go where it says.
  const hasChosen = useRef(false);
  useEffect(() => {
    if (!recipients || hasChosen.current) return;
    setTyped((was) => ({ ...was, to: addressText(recipients.to), cc: addressText(recipients.cc) }));
    setWriting((was) => ({ ...was, ...recipients }));
    setEdits((count) => (count > 0 ? count + 1 : count));
  }, [recipients]);

  return {
    writing,
    edits,
    typed,
    /** What the editor holds, as the member writes it or as the editor settles what it was given. */
    write: (markdown: string, isEdit: boolean) => {
      if (isEdit) edit(() => ({ markdown }));
      else setWriting((was) => ({ ...was, markdown }));
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
      return added.flatMap((attached) =>
        'file' in attached && attached.contentId
          ? [{ file: attached.file, contentId: attached.contentId }]
          : [],
      );
    },
    remove: (attached: Attached) =>
      edit((was) => ({ attachments: was.attachments.filter((each) => each !== attached) })),
    /** Names each file by the part of the saved draft that holds it, so its bytes cross once. */
    nameFiles: (named: Map<Attached, Attached>) =>
      setWriting((was) => ({
        ...was,
        attachments: was.attachments.map((attached) => named.get(attached) ?? attached),
      })),
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

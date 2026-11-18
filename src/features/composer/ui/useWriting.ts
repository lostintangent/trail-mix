import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Account, Address } from '../../mail/core/index.ts';
import { partUrl } from '../../mailroom/client/index.ts';
import {
  addressesOf,
  committed,
  fieldOf,
  problemIn,
  type AddressField,
} from '../core/completion.ts';
import { contentIdFor } from '../core/draft.ts';
import { sentFrom, type Attached, type Writing } from '../core/session.ts';
import type { Drafting } from './drafting.ts';

/** The fields a message's addresses are written in. */
export type AddressName = 'to' | 'cc' | 'bcc';

/** The address fields as the member writes them, which the message reads as addresses. */
export type AddressFields = Record<AddressName, AddressField>;

/** A chip that names no address, which keeps the message from being sent. */
export type AddressProblem = { field: AddressName; at: number; text: string };

/**
 * The message being written, as the member changes it. Each change of theirs owes a save. The
 * composer's own changes don't: the editor settling the text it was given, and files named by the
 * draft that saved them.
 */
export function useWriting(drafting: Drafting, recipients: Pick<Writing, 'to' | 'cc'> | undefined) {
  const writing = useSyncExternalStore(drafting.subscribe, () => drafting.writing);
  const [fields, setFields] = useState<AddressFields>(() => ({
    to: fieldOf(writing.to),
    cc: fieldOf(writing.cc),
    bcc: fieldOf(writing.bcc),
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
    setFields((was) => ({ ...was, to: fieldOf(recipients.to), cc: fieldOf(recipients.cc) }));
    drafting.write({ ...drafting.writing, ...recipients });
    if (hasEdited.current) drafting.owe();
  }, [recipients, drafting]);

  return {
    writing,
    fields,
    problem: problemOf(fields),
    /** What the editor holds, as the member writes it or as the editor settles what it was given. */
    write: (markdown: string, isEdit: boolean) => {
      if (isEdit) edit(() => ({ markdown }));
      else drafting.write({ ...drafting.writing, markdown });
    },
    /** A field as the member writes it. Only a change to the addresses it names owes a save. */
    address: (name: AddressName, field: AddressField) => {
      hasChosen.current = true;
      setFields((was) => ({ ...was, [name]: field }));
      const addresses = addressesOf(field);
      if (!isSame(addresses, drafting.writing[name])) edit(() => ({ [name]: addresses }));
    },
    /**
     * Makes what's typed in every field a chip, as Send does, and finds the first chip that names
     * no address. The message already holds every address typed, so nothing owes a save for it.
     */
    commitAddresses: (): AddressProblem | undefined => {
      const next = {
        to: committed(fields.to),
        cc: committed(fields.cc),
        bcc: committed(fields.bcc),
      };
      setFields(next);
      return problemOf(next);
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

function problemOf(fields: AddressFields): AddressProblem | undefined {
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const problem = problemIn(fields[field]);
    if (problem) return { field, ...problem };
  }
  return undefined;
}

const isSame = (a: readonly Address[], b: readonly Address[]) =>
  a.length === b.length &&
  a.every((each, at) => each.email === b[at]?.email && each.name === b[at]?.name);

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

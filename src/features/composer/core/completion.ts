import { addressesIn, type Address } from '../../mail/core/index.ts';
import { addressText } from './session.ts';

/**
 * Writing an address field, To, Cc or Bcc. The field holds each address written as a chip, and
 * what's being typed after them. What's typed becomes a chip once a comma or semicolon outside
 * quotes and angle brackets ends it, once a person is picked for it, or once the member leaves the
 * field or sends. Text that names no address becomes a chip as well, one that says so, and Send
 * waits until it's fixed or removed.
 */

/** What a chip holds: the address written, or text that names none. */
export type Chip = { address: Address } | { text: string };

/** An address field as the member writes it: its chips, and what's typed after them. */
export type AddressField = { chips: readonly Chip[]; typing: string };

/** A field holding addresses, as a reply, a forward or a draft opened again begins. */
export function fieldOf(addresses: readonly Address[]): AddressField {
  return { chips: addresses.map((address) => ({ address })), typing: '' };
}

/** The field as the member types: each address a comma or semicolon ends becomes a chip. */
export function typed(field: AddressField, typing: string): AddressField {
  const parts = partsOf(typing);
  const last = parts.pop() ?? '';
  return { chips: withChips(field.chips, parts.flatMap(chipsIn)), typing: last.trimStart() };
}

/**
 * The field once text is pasted into what's typed, when it names several addresses, which become a
 * chip each. A paste of one address lands as typing, for the member to go on with.
 */
export function pasted(field: AddressField, typing: string): AddressField | undefined {
  const chips = partsOf(typing).flatMap(chipsIn);
  return chips.length > 1 ? { chips: withChips(field.chips, chips), typing: '' } : undefined;
}

/** The field with what's typed made a chip, as Enter, leaving the field or Send makes it. */
export function committed(field: AddressField): AddressField {
  return { chips: withChips(field.chips, partsOf(field.typing).flatMap(chipsIn)), typing: '' };
}

/** The field with `person` picked for what's typed. */
export function picked(field: AddressField, person: Address): AddressField {
  return { chips: withChips(field.chips, [{ address: person }]), typing: '' };
}

/** The field without the chip at `at`. */
export function removed(field: AddressField, at: number): AddressField {
  return { ...field, chips: field.chips.filter((_, each) => each !== at) };
}

/**
 * The field with the chip at `at` back as typing, to write again. What was typed before becomes a
 * chip first, so nothing is lost.
 */
export function editing(field: AddressField, at: number): AddressField {
  const chip = field.chips[at];
  if (!chip) return field;
  return { chips: committed(removed(field, at)).chips, typing: textOf(chip) };
}

/** A chip as text, as it goes back to be written again. */
export function textOf(chip: Chip): string {
  return 'address' in chip ? addressText([chip.address]) : chip.text;
}

/** Whether the field holds anything to send to: a chip, or what's typed, which Send makes one. */
export function isWritten(field: AddressField): boolean {
  return field.chips.length > 0 || field.typing.trim() !== '';
}

/**
 * The addresses the field names: its chips', and whatever is typed, which a save or Send takes
 * before it becomes a chip.
 */
export function addressesOf(field: AddressField): Address[] {
  return committed(field).chips.flatMap((chip) => ('address' in chip ? [chip.address] : []));
}

/** The field's first chip that names no address, and where it lies, if it holds one. */
export function problemIn(field: AddressField): { at: number; text: string } | undefined {
  for (const [at, chip] of field.chips.entries())
    if ('text' in chip) return { at, text: chip.text };
  return undefined;
}

/** What's typed, to complete from: nothing once it holds an address in angle brackets. */
export function queryOf(field: AddressField): string {
  const query = field.typing.trim();
  return /[<>]/.test(query) ? '' : query;
}

/** The people to offer for what's typed: those the field holds no chip for. */
export function completionsFor(field: AddressField, people: readonly Address[]): Address[] {
  const named = new Set(field.chips.map(keyOf));
  return people.filter(({ email }) => !named.has(email.toLowerCase()));
}

/**
 * Those of `people` whom `query` still names, near enough to how the Mailroom matches them: each
 * word of it begins a word of their name or address, in any case and with or without accents. So
 * the list for fewer letters can stand while more are typed, until the Mailroom answers, and Enter
 * never picks someone what's typed no longer names.
 */
export function stillNamed(people: readonly Address[], query: string): Address[] {
  const typed = wordsOf(query);
  return people.filter(({ name, email }) => {
    const words = wordsOf(`${name ?? ''} ${email}`);
    return typed.every((word) => words.some((theirs) => theirs.startsWith(word)));
  });
}

const wordsOf = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * What's typed, cut where each address ends: at a comma, a semicolon or a line break outside quotes
 * and angle brackets. A pasted list may put each address on a line of its own.
 */
function partsOf(typing: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let isQuoted = false;
  let isAngled = false;
  for (let at = 0; at < typing.length; at++) {
    const char = typing[at];
    if (isQuoted) {
      if (char === '\\') at++;
      else if (char === '"') isQuoted = false;
    } else if (isAngled) {
      if (char === '>') isAngled = false;
    } else if (char === '"') isQuoted = true;
    else if (char === '<') isAngled = true;
    else if (char === ',' || char === ';' || char === '\n' || char === '\r') {
      parts.push(typing.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(typing.slice(start));
  return parts;
}

/**
 * The chips one written address makes: one for the address, one for each of several bare
 * addresses a space parts, as a pasted list may, or one that says it names no address.
 */
function chipsIn(part: string): Chip[] {
  const text = part.trim();
  if (text === '') return [];
  const words = text.split(/\s+/);
  if (words.length > 1 && words.every((word) => BARE.test(word))) {
    return words.map((email) => ({ address: { email } }));
  }
  const addresses = addressesIn(text);
  return addresses.length > 0 ? addresses.map((address) => ({ address })) : [{ text }];
}

const BARE = /^[^@\s<>"(),;:]+@[^@\s<>"(),;:]+$/;

/** The chips with more added, leaving out any address the field already holds. */
function withChips(chips: readonly Chip[], more: readonly Chip[]): Chip[] {
  const held = new Set(chips.map(keyOf));
  const added = more.filter((chip) => {
    const key = keyOf(chip);
    if (key === undefined) return true;
    if (held.has(key)) return false;
    held.add(key);
    return true;
  });
  return [...chips, ...added];
}

const keyOf = (chip: Chip) => ('address' in chip ? chip.address.email.toLowerCase() : undefined);

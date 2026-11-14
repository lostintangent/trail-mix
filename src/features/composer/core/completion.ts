import { addressesIn, type Address } from '../../mail/core/index.ts';
import { addressText } from './session.ts';

/**
 * Completing an address field. A field holds addresses as the member writes them, each ended by a
 * comma or semicolon outside quotes and angle brackets. The address being typed is the one the
 * caret is in, and a person picked for it takes its place, with a comma after it for the next.
 */

/** The address the caret is in: where it lies in the field, and what to complete it from. */
export type Typing = {
  start: number;
  end: number;
  /** What was typed of it, or empty once it holds an address in angle brackets, as a pick does. */
  query: string;
};

/** The address the caret is in. */
export function typingIn(field: string, caret: number): Typing {
  let start = 0;
  let end = field.length;
  let isQuoted = false;
  let isAngled = false;
  for (let at = 0; at < field.length; at++) {
    const char = field[at];
    if (isQuoted) {
      if (char === '\\') at++;
      else if (char === '"') isQuoted = false;
    } else if (isAngled) {
      if (char === '>') isAngled = false;
    } else if (char === '"') isQuoted = true;
    else if (char === '<') isAngled = true;
    else if (char === ',' || char === ';') {
      if (at < caret) start = at + 1;
      else {
        end = at;
        break;
      }
    }
  }
  const typed = field.slice(start, end).trim();
  return { start, end, query: /[<>]/.test(typed) ? '' : typed };
}

/** The people to offer for the address being typed: those the field doesn't name elsewhere. */
export function completionsFor(field: string, typing: Typing, people: readonly Address[]) {
  const named = new Set(
    addressesIn(field.slice(0, typing.start) + field.slice(typing.end)).map(({ email }) =>
      email.toLowerCase(),
    ),
  );
  return people.filter(({ email }) => !named.has(email.toLowerCase()));
}

/**
 * The field with the address being typed completed to `person`, and where the caret goes: after
 * the comma that follows the last address, ready for the next, or else after the address itself.
 */
export function completed(
  field: string,
  typing: Typing,
  person: Address,
): { field: string; caret: number } {
  const before = field.slice(0, typing.start) + (typing.start > 0 ? ' ' : '');
  const after = field.slice(typing.end);
  const written = before + addressText([person]);
  return after === ''
    ? { field: `${written}, `, caret: written.length + 2 }
    : { field: written + after, caret: written.length };
}

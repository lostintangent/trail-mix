/**
 * A conversation's subject as the reader sets it: as a message gave it, without the replies' and
 * forwards' prefixes, in any of the languages mail clients write them in.
 */
export function bareSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|wg|sv|vs)\s*:\s*)+/i, '').trim() || '(no subject)';
}

/**
 * How a forward Trail Mix wrote marks itself: the composer finds it again by these when a draft
 * opens or saves, and the reader folds it by them. They are apart from the forward itself, so the
 * reader takes three names and none of what writes them.
 */

/** The line that starts a forward, as Gmail writes it and every client knows it. */
export const FORWARD_MARKER = '---------- Forwarded message ---------';

/** The header that names the message a forward carries, as Thunderbird writes it. */
export const FORWARDED_HEADER = 'X-Forwarded-Message-Id';

/** The class of the element that holds a forward under its note, header block and original. */
export const FORWARD_CLASS = 'trailmix-forward';

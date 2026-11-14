/** Nine in the morning, when the Outbox's tests send. */
const NINE = Date.parse('2026-11-10T09:00:00.000Z');
/** The time `seconds` after nine. */
export const at = (seconds: number) => NINE + seconds * 1000;
export const iso = (seconds: number) => new Date(at(seconds)).toISOString();
/** The draft they send, in Personal's Drafts. */
export const draft = { account: 'personal', path: 'Drafts', uidValidity: 7, uid: 42 };

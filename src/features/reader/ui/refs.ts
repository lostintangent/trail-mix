import type { MessageRef } from '../../mail/core/index.ts';

/** Just a message's identity, as queries and URLs name it. */
export const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});

/** A message's identity as one string, to key it by. */
export const refKey = ({ account, path, uidValidity, uid }: MessageRef) =>
  [account, path, uidValidity, uid].join('\u0000');

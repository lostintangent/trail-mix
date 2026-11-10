import type { MessageRef } from './model.ts';

/** Whether two refs name the same message. */
export const sameRef = (a: MessageRef, b: MessageRef) =>
  a.account === b.account &&
  a.path === b.path &&
  a.uidValidity === b.uidValidity &&
  a.uid === b.uid;

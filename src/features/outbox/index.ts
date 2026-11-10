// The Mailroom reads the state machine from `core/index.ts`, which leaves the browser's views out.
export * from './core/index.ts';
export { useOutboxCommands } from './ui/commands.ts';
export { draftIn, sendCommands } from './ui/sendCommands.ts';
export { OutboxList, SendActions, SendDraft } from './ui/lazy.ts';
export { useSend, type Send, type SendOptions } from './ui/useSend.ts';

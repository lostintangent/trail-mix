// The Mailroom reads the state machine from `core/index.ts`, which leaves the browser's views out.
export * from './core/index.ts';
export { useOutboxCommands } from './ui/commands.ts';
export { sendCommands } from './ui/sendCommands.ts';
export { useSendCommands } from './ui/useSendCommands.ts';
export { OutboxList, SendActions, preloadSendActions } from './ui/lazy.ts';
export { useSend, type Send, type SendOptions } from './ui/useSend.ts';
export { useLeaving, useLeavingStanding, type LeavingSends } from './ui/useLeaving.ts';
export { useDraftsAway } from './ui/useDraftsAway.ts';
export { isDraftsView, leavesDrafts } from './core/drafts.ts';
export { Airmail } from './ui/Airmail.tsx';
export { isAwaitingCopy, leavingIn, type Leaving, type Shown } from './core/leaving.ts';
export { formatAhead } from './core/later.ts';
export { isOnItsWay, type Standing } from './core/standing.ts';

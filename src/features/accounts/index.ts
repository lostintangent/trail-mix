// The account screens as the app shows them. The commands come with the first screen, and every
// screen loads apart from it.
export type { AccountPageOf } from './ui/AccountPage.tsx';
export { accountCommands } from './ui/commands.ts';
export { AccountPage, FirstRun, RemoveQuestion } from './ui/lazy.ts';

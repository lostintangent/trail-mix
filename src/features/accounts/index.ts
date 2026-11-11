// The account screens as the app shows them. The commands come with the first screen, and every
// screen loads apart from it.
export type { AccountPageOf } from './ui/AccountPage.tsx';
export { accountCommands, isAccountCommand } from './ui/commands.ts';
export {
  AccountPage,
  EraseQuestion,
  FirstRun,
  preloadFirstRun,
  RemoveQuestion,
} from './ui/lazy.ts';

// The composer as the workbench shows it. The Mailroom reaches only its core, through the
// feature's own index, so the Worker never takes in the editor.
export { composerCommands } from './commands.ts';
export { Composer, preloadComposer } from './lazy.ts';
export { holdKeys, releaseKeys, useIsReplyOnItsWay } from './heldKeys.ts';
export { ComposerSkeleton, isDocked } from './sheet.tsx';
export type { Compose, ComposerSend } from './Composer.tsx';
export type { Drafting } from './drafting.ts';

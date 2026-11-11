// The composer as the workbench shows it. The Mailroom reaches only its core, through the
// feature's own index, so the Worker never takes in the editor.
export { composerCommands } from './commands.ts';
export { Composer, preloadComposer } from './lazy.ts';
export { ComposerSkeleton, isDocked } from './sheet.tsx';
export type { Compose, ComposerProps, Sender } from './Composer.tsx';
export type { Writing } from '../core/session.ts';

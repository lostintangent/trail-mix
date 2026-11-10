export type { Cursor, MailProvider, Moved, SyncBatch, SyncEvent, SyncWindow } from './provider.ts';
export { FIRST_SYNC_BATCH, SEARCH_LIMIT, SendFailure } from './provider.ts';
export {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  type DemoKind,
  type DemoMailbox,
  type DemoServer,
} from './demo/provider.ts';
export { checkSignIn, imapProvider, type ImapAccount, type Network } from './imap/provider.ts';
export { PRESETS, type Endpoint, type Preset, type PresetName } from './imap/core/index.ts';

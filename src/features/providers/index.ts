export type { Cursor, MailProvider, SyncBatch, SyncEvent, SyncWindow } from './provider.ts';
export {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  type DemoKind,
  type DemoMailbox,
  type DemoServer,
} from './demo/provider.ts';
export { imapProvider, type Endpoint, type ImapAccount, type Network } from './imap/provider.ts';
export { PRESETS, type Preset, type PresetName } from './imap/presets.ts';

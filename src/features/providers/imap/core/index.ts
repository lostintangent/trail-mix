// What the browser may use of the IMAP provider: the vendors' presets, with no mail library behind them.
export { PRESETS, type Endpoint, type Preset, type PresetName } from './presets.ts';
export {
  EXPIRED,
  codeFrom,
  codeRequest,
  isFresh,
  pollRequest,
  polled,
  refreshRequest,
  refreshed,
  withStandIn,
  type Answer,
  type DeviceCode,
  type DeviceSignIn,
  type Polled,
  type Refreshed,
  type Request,
  type Tokens,
} from './device-sign-in.ts';

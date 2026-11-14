// What the browser may use of the IMAP provider: the vendors' presets, with no mail library behind them.
export {
  PRESETS,
  authServersFor,
  withStandIn,
  type Endpoint,
  type Preset,
  type PresetName,
} from './presets.ts';
export {
  EXPIRED,
  codeFrom,
  namesThisMachine,
  codeRequest,
  isFresh,
  pollRequest,
  polled,
  refreshRequest,
  refreshed,
  type Answer,
  type Client,
  type DeviceCode,
  type DeviceSignIn,
  type Polled,
  type Request,
  type Tokens,
} from './device-sign-in.ts';

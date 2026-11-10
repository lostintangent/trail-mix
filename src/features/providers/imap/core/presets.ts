import { namesThisMachine, type DeviceSignIn } from './device-sign-in.ts';

/** Where a host listens. Implicit TLS when `secure`, STARTTLS otherwise. */
export type Endpoint = { host: string; port: number; secure: boolean };

/**
 * Vendors are presets of the one IMAP and SMTP provider: their hosts and ports, how a member signs
 * in, and their quirks. Any other host works by entering its endpoints.
 */
export type Preset = {
  imap: Endpoint;
  smtp: Endpoint;
  /** How a member signs in at the vendor with a device code, where that replaces a password. */
  device?: DeviceSignIn;
  /** Whether the host files its own copy in Sent when it accepts a message. */
  filesSent: boolean;
};

export const PRESETS = {
  // Zoho's server names depend on the account's plan and data center: imappro and smtppro for a paid
  // organization, imap and smtp for a personal or free one, and other domains outside the US. These
  // are only filled in, and an account uses the names its own Zoho settings list.
  // Whether Zoho files submitted mail in Sent is measured when the operator's account connects.
  zoho: {
    imap: { host: 'imappro.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtppro.zoho.com', port: 465, secure: true },
    filesSent: false,
  },
  outlook: {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    // Personal Microsoft accounts, through the app the operator registered in Microsoft Entra.
    device: {
      vendor: 'Microsoft',
      dialect: 'microsoft',
      authority: 'https://login.microsoftonline.com/consumers',
      // IMAP and SMTP as the member, and offline_access for a refresh token, so they stay signed in.
      scopes: [
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
        'offline_access',
      ],
      whenRefused: 'If IMAP is off in Outlook.com’s settings, turn it on, then get a new code.',
    },
    filesSent: true,
  },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

/**
 * A preset with a test's stand-ins for its vendor, given as JSON: where it signs in, and its hosts,
 * such as `{"authority":"http://127.0.0.1:4080/consumers","imap":{…},"smtp":{…}}`. Honored only
 * when every address in it names this machine, so a deployment's mail and tokens only ever go to
 * the vendor itself.
 */
export function withStandIn(preset: Preset, standIn: string | undefined): Preset {
  const given = parsed(standIn);
  if (!preset.device || typeof given !== 'object' || given === null) return preset;
  const { authority, imap, smtp } = given as Record<string, unknown>;
  if (typeof authority !== 'string' || !namesThisMachine(authority)) return preset;
  if (!isLocal(imap) || !isLocal(smtp)) return preset;
  return {
    ...preset,
    imap,
    smtp,
    device: { ...preset.device, authority: authority.replace(/\/$/, '') },
  };
}

/** An endpoint on this machine. */
function isLocal(value: unknown): value is Endpoint {
  if (typeof value !== 'object' || value === null) return false;
  const { host, port, secure } = value as Record<string, unknown>;
  return (
    typeof host === 'string' &&
    ['localhost', '127.0.0.1', '::1'].includes(host) &&
    Number.isInteger(port) &&
    typeof secure === 'boolean'
  );
}

function parsed(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

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
  /**
   * Whether the host files its own copy in Sent of a message it accepts, perhaps a while after, so
   * the Outbox waits for it before filing one itself.
   */
  filesSent: boolean;
  /**
   * The names the vendor's receiving servers sign Authentication-Results with, at the top of each
   * message they deliver, by the domain of the hosts an account reaches. None for a vendor whose
   * servers write it without a name, whose senders then never count as verified.
   */
  authServers: Readonly<Record<string, readonly string[]>>;
};

export const PRESETS = {
  // Zoho's server names depend on the account's plan and data center: imappro and smtppro for a paid
  // organization, imap and smtp for a personal or free one, and other domains outside the US. These
  // are only filled in, and an account uses the names its own Zoho settings list.
  // Zoho files its own copy of what it accepts in Sent, a moment after it accepts, which the
  // operator's first send showed. A member can turn that off in Zoho's settings, and then the
  // Outbox files the copy once its wait for Zoho's is over.
  zoho: {
    imap: { host: 'imappro.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtppro.zoho.com', port: 465, secure: true },
    filesSent: true,
    // Each data center signs with its own name, and an account trusts only its own center's, so a
    // header a sender wrote in another center's name never counts. The US name is the one Zoho's
    // headers show. The others follow its pattern, and a wrong one would only show initials.
    authServers: {
      'zoho.com': ['mx.zohomail.com'],
      'zoho.eu': ['mx.zohomail.eu', 'mx.zoho.eu'],
      'zoho.in': ['mx.zohomail.in', 'mx.zoho.in'],
      'zoho.com.au': ['mx.zohomail.com.au', 'mx.zoho.com.au'],
      'zoho.jp': ['mx.zohomail.jp', 'mx.zoho.jp'],
      'zohocloud.ca': ['mx.zohocloud.ca'],
      'zoho.sa': ['mx.zoho.sa'],
    },
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
    // Microsoft's servers write Authentication-Results without a name of their own, so a sender
    // could write one that reads the same. Until a real message shows a safe reading, none.
    authServers: {},
  },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

/**
 * The names an account's receiving servers sign Authentication-Results with, from the preset whose
 * hosts share the domain of the account's IMAP host, whether or not the account was set up with
 * that preset. A test's stand-in names its servers on this machine as JSON, such as
 * `{"localhost":["mx.trailmix.test"]}`, and is honored for hosts on this machine alone.
 */
export function authServersFor(host: string, standIn?: string): readonly string[] {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (LOOPBACK.includes(name)) {
    const given = parsed(standIn);
    const names =
      typeof given === 'object' && given !== null
        ? (given as Record<string, unknown>)[name]
        : undefined;
    return Array.isArray(names)
      ? names.filter((each): each is string => typeof each === 'string')
      : [];
  }
  for (const preset of Object.values(PRESETS) as Preset[]) {
    for (const [domain, names] of Object.entries(preset.authServers)) {
      if (name === domain || name.endsWith(`.${domain}`)) return names;
    }
  }
  return [];
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

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
    LOOPBACK.includes(host) &&
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

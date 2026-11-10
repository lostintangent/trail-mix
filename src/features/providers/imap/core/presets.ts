import type { DeviceSignIn } from './device-sign-in.ts';

/** Where a host listens. Implicit TLS when `secure`, STARTTLS otherwise. */
export type Endpoint = { host: string; port: number; secure: boolean };

/**
 * Vendors are presets of the one IMAP and SMTP provider: their hosts and ports, how a member signs
 * in, and their quirks. Any other host works by entering its endpoints.
 */
export type Preset = {
  imap: Endpoint;
  smtp: Endpoint;
  /** A password, or a sign-in at the vendor with a device code. */
  signIn: 'password' | DeviceSignIn;
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
    signIn: 'password',
    filesSent: false,
  },
  outlook: {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    // Personal Microsoft accounts, through the app the operator registered in Microsoft Entra.
    signIn: {
      vendor: 'Microsoft',
      authority: 'https://login.microsoftonline.com/consumers',
      codePath: '/oauth2/v2.0/devicecode',
      tokenPath: '/oauth2/v2.0/token',
      // IMAP and SMTP as the member, and offline_access for a refresh token, so they stay signed in.
      scopes: [
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
        'offline_access',
      ],
    },
    filesSent: true,
  },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

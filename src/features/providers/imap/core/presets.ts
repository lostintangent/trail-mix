/** Where a host listens. Implicit TLS when `secure`, STARTTLS otherwise. */
export type Endpoint = { host: string; port: number; secure: boolean };

/**
 * Vendors are presets of the one IMAP and SMTP provider: their hosts and ports, how a member signs
 * in, and their quirks. Any other host works by entering its endpoints.
 */
export type Preset = {
  imap: Endpoint;
  smtp: Endpoint;
  /** A password, or Microsoft's device-code sign-in. */
  signIn: 'password' | 'microsoft';
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
    signIn: 'microsoft',
    filesSent: true,
  },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

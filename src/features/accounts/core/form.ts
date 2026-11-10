import type { Account } from '../../mail/core/index.ts';

/**
 * The add-account form, as the member fills it in, and the setup it becomes. Zoho is a preset whose
 * server names come filled in and can be changed, since Zoho gives each account the names its own
 * settings list. Any other host is reached by its server names and ports. A password is only ever
 * held here, in the form, until it goes to the Mailroom.
 */
export type AccountForm = {
  server: 'zoho' | 'other';
  /** What the sidebar calls the account. Left empty, it is the address's domain. */
  name: string;
  address: string;
  /** The name recipients see beside the address. */
  fromName: string;
  password: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
};

/** A host as the Mailroom reaches it: over TLS from the start, or else STARTTLS, never in the clear. */
export type Server = { host: string; port: number; secure: boolean };

/** What a preset fills in, and the ports and TLS it keeps. */
export type PresetServers = { imap: Server; smtp: Server };

/** Where a form for a host of the member's own starts: IMAP and submission, both over TLS. */
const OTHER: PresetServers = {
  imap: { host: '', port: 993, secure: true },
  smtp: { host: '', port: 465, secure: true },
};

/** The ports that start in the clear and switch to TLS with STARTTLS. Any other port is TLS. */
const STARTTLS_PORTS = new Set([25, 143, 587]);

export const isSecurePort = (port: number) => !STARTTLS_PORTS.has(port);

/** A form for a server, keeping what the member already typed about themselves. */
export function formFor(
  server: AccountForm['server'],
  zoho: PresetServers,
  kept?: Pick<AccountForm, 'name' | 'address' | 'fromName' | 'password'>,
): AccountForm {
  const { imap, smtp } = server === 'zoho' ? zoho : OTHER;
  return {
    server,
    name: kept?.name ?? '',
    address: kept?.address ?? '',
    fromName: kept?.fromName ?? '',
    password: kept?.password ?? '',
    imapHost: imap.host,
    imapPort: String(imap.port),
    smtpHost: smtp.host,
    smtpPort: String(smtp.port),
  };
}

/** The name an account goes by when the member gives none: its address's domain. */
export function nameFor(form: Pick<AccountForm, 'name' | 'address'>): string {
  return form.name.trim() || form.address.trim().split('@')[1]?.toLowerCase() || '';
}

export type Problems = Partial<Record<keyof AccountForm, string>>;

/** Why the form can't be sent yet, field by field, said before anything reaches the Mailroom. */
export function formProblems(form: AccountForm, accounts: readonly Account[]): Problems {
  const problems: Problems = {};
  const address = form.address.trim();
  if (!ADDRESS.test(address)) {
    problems.address = 'Enter the whole address, such as you@example.com.';
  } else if (accounts.some((held) => held.address.toLowerCase() === address.toLowerCase())) {
    problems.address = `${address} is already connected.`;
  }
  if (nameFor(form).length > 200) problems.name = 'A name can be up to 200 characters.';
  if (form.fromName.trim().length > 200) problems.fromName = 'A name can be up to 200 characters.';
  if (!form.password) problems.password = 'Enter the password.';
  for (const [host, port, what] of [
    ['imapHost', 'imapPort', 'IMAP'],
    ['smtpHost', 'smtpPort', 'SMTP'],
  ] as const) {
    if (!HOST.test(form[host].trim())) {
      problems[host] =
        `Enter the ${what} server’s name, such as ${what.toLowerCase()}.example.com.`;
    }
    if (!isPort(form[port].trim())) problems[port] = 'A port is a number from 1 to 65535.';
  }
  return problems;
}

/**
 * What the Mailroom is asked to connect. A preset keeps its ports and TLS under the names typed for
 * it, and a host of the member's own is reached on its ports, over TLS unless a port says STARTTLS.
 */
export function setupFrom(form: AccountForm, zoho: PresetServers) {
  const isZoho = form.server === 'zoho';
  const at = (host: string, port: string, preset: Server): Server => {
    const number = Number(port.trim());
    return isZoho
      ? { host: host.trim(), port: preset.port, secure: preset.secure }
      : { host: host.trim(), port: number, secure: isSecurePort(number) };
  };
  const fromName = form.fromName.trim();
  return {
    provider: 'imap' as const,
    name: nameFor(form),
    address: form.address.trim(),
    ...(fromName ? { fromName } : {}),
    ...(isZoho ? { preset: 'zoho' as const } : {}),
    imap: at(form.imapHost, form.imapPort, zoho.imap),
    smtp: at(form.smtpHost, form.smtpPort, zoho.smtp),
    password: form.password,
  };
}

/** One @, something before it, and a domain with a dot in it. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** What the Mailroom takes as a host's name. */
const HOST = /^[a-z0-9.-]{1,253}$/i;

const isPort = (text: string) =>
  /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535;

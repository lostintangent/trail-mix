import { byteHeaders, notFound } from './messages.ts';

/**
 * `/logos/<domain>` serves a verified sender's logo from the Logo cache. A domain's owner drew it,
 * so it is served like a message's own bytes: Trail Mix shows it only as an image, which runs and
 * loads nothing, and opened directly it is an opaque document under a sandboxing policy.
 */

/** What the Mailroom serves of its Logo cache. Null means it holds no logo for the domain. */
export type LogoBytes = { logo: (domain: string) => Promise<string | null> };

export async function serveLogo(domain: string, mailroom: LogoBytes): Promise<Response> {
  const svg = await mailroom.logo(domain);
  if (svg === null) return notFound();
  return new Response(svg, {
    headers: byteHeaders({
      type: 'image/svg+xml',
      name: `${domain}.svg`,
      // A logo is looked up again each week, so a day's copy is never far behind.
      cache: 'private, max-age=86400',
    }),
  });
}

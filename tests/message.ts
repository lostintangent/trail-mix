/** The picture a message's HTML shows as `cid:logo@example.com`, when it carries its logo. */
export const LOGO = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * An RFC 5322 message as a mail client writes one: its text, its HTML or both, or its text with a
 * file attached. Its id is `<id@example.com>`, and `headers` go above all the others. With `logo`,
 * its HTML carries {@link LOGO}, related to it.
 */
export function message(fields: {
  id: string;
  subject: string;
  headers?: string[];
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  list?: string;
  text?: string;
  html?: string;
  attachment?: boolean;
  logo?: boolean;
  /** When it was sent, by default `minutesAgo` before now. */
  date?: Date;
  minutesAgo?: number;
}): string {
  const date = fields.date ?? new Date(Date.now() - (fields.minutesAgo ?? 0) * 60_000);
  const headers = [
    ...(fields.headers ?? []),
    `From: ${fields.from ?? 'Ada Park <ada@example.com>'}`,
    `To: ${fields.to ?? 'me@trailmix.test'}`,
    ...(fields.cc ? [`Cc: ${fields.cc}`] : []),
    ...(fields.bcc ? [`Bcc: ${fields.bcc}`] : []),
    `Subject: ${fields.subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${fields.id}@example.com>`,
    ...(fields.inReplyTo ? [`In-Reply-To: <${fields.inReplyTo}@example.com>`] : []),
    ...(fields.list ? [`List-Id: News <${fields.list}>`] : []),
    'MIME-Version: 1.0',
  ];
  const text = (fields.text !== undefined || fields.html === undefined) && [
    'Content-Type: text/plain; charset=utf-8',
    '',
    fields.text ?? `This is ${fields.subject}.`,
  ];
  const html =
    fields.html !== undefined &&
    (fields.logo
      ? [
          'Content-Type: multipart/related; boundary="related"',
          '',
          '--related',
          'Content-Type: text/html; charset=utf-8',
          '',
          fields.html,
          '--related',
          'Content-Type: image/png',
          'Content-ID: <logo@example.com>',
          'Content-Disposition: inline; filename="logo.png"',
          'Content-Transfer-Encoding: base64',
          '',
          LOGO.toBase64(),
          '--related--',
        ]
      : ['Content-Type: text/html; charset=utf-8', '', fields.html]);
  const file = fields.attachment === true && [
    'Content-Type: application/pdf; name="plan.pdf"',
    'Content-Disposition: attachment; filename="plan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa('%PDF-1.4 a plan'),
  ];
  const parts = [text, html, file].filter((part) => part !== false);
  const body =
    parts.length > 1
      ? [
          `Content-Type: multipart/${file ? 'mixed' : 'alternative'}; boundary="part"`,
          '',
          ...parts.flatMap((part) => ['--part', ...part]),
          '--part--',
        ]
      : parts.flat();
  return [...headers, ...body, ''].join('\r\n');
}

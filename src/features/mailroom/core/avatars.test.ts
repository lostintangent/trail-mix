import { describe, expect, test } from 'bun:test';
import type { ConversationSummary, Envelope, Message, SyncEvent } from '../../mail/core/index.ts';
import { DEMO_PICTURES } from '../../providers/index.ts';
import {
  avatarOf,
  bimiOf,
  dmarcOf,
  enforces,
  hostsPublicMailboxes,
  iconLocations,
  isSafeLogo,
  LOGO_BYTES,
  avatarCandidates,
  namedMessages,
  namedRows,
  organizationalOf,
  PICTURE_BYTES,
  pictureOf,
  txtOf,
  verifiedSenders,
  walkOf,
  type Dmarc,
} from './avatars.ts';

const envelope = (email: string, verified: boolean, uid = 1): Envelope => ({
  account: 'personal',
  path: 'INBOX',
  uidValidity: 1,
  uid,
  messageId: `<${uid}@example.com>`,
  references: [],
  from: { email },
  to: [],
  cc: [],
  subject: 'Hello',
  date: '2026-11-09T12:00:00.000Z',
  preview: '',
  flags: { seen: false, flagged: false, answered: false, draft: false },
  hasAttachments: false,
  verified,
});

const message = (email: string, verified: boolean, uid = 1): Message => ({
  ...envelope(email, verified, uid),
  conversation: 'c',
});

const row = (id: string, avatar?: string): ConversationSummary => ({
  id,
  account: 'personal',
  subject: 'Hello',
  senders: [],
  preview: '',
  date: '2026-11-09T12:00:00.000Z',
  count: 1,
  unread: 0,
  flagged: false,
  hasAttachments: false,
  ...(avatar ? { avatar } : {}),
});

describe('who may show a picture', () => {
  test('a batch’s verified senders are the From addresses of its verified messages, once each', () => {
    const events: SyncEvent[] = [
      { type: 'message', envelope: envelope('news@Brand.Example', true, 1) },
      { type: 'message', envelope: envelope('deals@brand.example', true, 2) },
      { type: 'message', envelope: envelope('friend@mail.example', false, 3) },
      { type: 'flags', ref: envelope('x@other.example', true, 4), flags: envelope('', true).flags },
      { type: 'gone', ref: envelope('x@gone.example', true, 5) },
    ];
    expect(verifiedSenders(events)).toEqual(['news@brand.example', 'deals@brand.example']);
  });

  test('a row names its sender’s picture by its key, only while the cache holds one', () => {
    const rows = [row('a', 'news@brand.example'), row('b', 'gone@lapsed.example'), row('c')];
    const named = namedRows(rows, new Map([['news@brand.example', 'k1']]));

    expect(named[0]).toEqual(row('a', 'k1'));
    expect(named[1]).toEqual(row('b'));
    expect(named[1]).not.toHaveProperty('avatar');
    expect(named[2]).toEqual(row('c'));
  });

  test('a message names its sender’s picture only when it is verified and the cache holds one', () => {
    const pictures = new Map([['news@brand.example', 'k1']]);
    const [verified, unverified, elsewhere] = namedMessages(
      [
        message('News@Brand.Example', true),
        message('news@brand.example', false),
        message('hi@other.example', true),
      ],
      pictures,
    );
    expect(verified?.avatar).toBe('k1');
    expect(unverified).not.toHaveProperty('avatar');
    expect(elsewhere).not.toHaveProperty('avatar');
    // A picture a message carried in is never trusted.
    const [carried] = namedMessages(
      [{ ...message('a@forged.example', false), avatar: 'k1' }],
      pictures,
    );
    expect(carried).not.toHaveProperty('avatar');
  });

  test('the cache is asked only about the senders rows and verified messages could name', () => {
    expect(
      avatarCandidates(
        [row('a', 'news@brand.example'), row('b')],
        [
          message('X@Shop.example', true),
          message('y@person.example', false),
          message('nobody', true),
        ],
      ),
    ).toEqual(['news@brand.example', 'x@shop.example']);
  });
});

describe('which picture a sender shows', () => {
  test('their brand’s logo, else their photo, else their site’s icon, else none', () => {
    expect(avatarOf({ logo: 'logo', photo: 'photo', icon: 'icon' })).toBe('logo');
    expect(avatarOf({ logo: null, photo: 'photo', icon: 'icon' })).toBe('photo');
    expect(avatarOf({ logo: null, photo: null, icon: 'icon' })).toBe('icon');
    expect(avatarOf({ icon: 'icon' })).toBe('icon');
    expect(avatarOf({ logo: null, photo: null, icon: null })).toBeUndefined();
    expect(avatarOf({})).toBeUndefined();
  });

  test('a domain that hosts mailboxes for the public gives no one its icon', () => {
    for (const domain of [
      'gmail.com',
      'Outlook.com',
      'hotmail.co.uk',
      'yahoo.co.jp',
      'gmx.de',
      'icloud.com',
      'me.com',
      'proton.me',
      'fastmail.com',
      'zoho.com',
      'qq.com',
    ]) {
      expect(hostsPublicMailboxes(domain)).toBe(true);
    }
    for (const domain of [
      'brand.example',
      'github.com',
      'gmail.brand.example',
      'mail.example.com',
    ]) {
      expect(hostsPublicMailboxes(domain)).toBe(false);
    }
  });
});

describe('a picture Trail Mix keeps', () => {
  const bytesOf = (...parts: (string | number[])[]) =>
    new Uint8Array(
      parts.flatMap((part) =>
        typeof part === 'string' ? [...new TextEncoder().encode(part)] : part,
      ),
    );
  const PNG = bytesOf([0x89], 'PNG\r\n\x1a\n', 'rest of the image');

  test('is a PNG, JPEG, GIF, WebP or ICO by its first bytes', () => {
    expect(pictureOf(PNG)?.type).toBe('image/png');
    expect(pictureOf(bytesOf([0xff, 0xd8, 0xff, 0xe0], 'JFIF'))?.type).toBe('image/jpeg');
    expect(pictureOf(bytesOf('GIF89a', [1, 0, 1, 0]))?.type).toBe('image/gif');
    expect(pictureOf(bytesOf('GIF87a', [1, 0, 1, 0]))?.type).toBe('image/gif');
    expect(pictureOf(bytesOf('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))?.type).toBe('image/webp');
    expect(pictureOf(bytesOf([0, 0, 1, 0, 1, 0], 'entries'))?.type).toBe('image/x-icon');
    expect(pictureOf(PNG)?.bytes).toBe(PNG);
  });

  test('or an SVG that is a safe logo', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
    expect(pictureOf(bytesOf(svg))?.type).toBe('image/svg+xml');
    expect(pictureOf(bytesOf(svg.replace('<rect', '<script>alert(1)</script><rect')))).toBe(
      undefined,
    );
    expect(pictureOf(bytesOf(`${svg}${' '.repeat(LOGO_BYTES)}`))).toBeUndefined();
  });

  test('is never a page, a document or anything else, whatever its host labels it', () => {
    for (const bytes of [
      bytesOf('<!doctype html><script>alert(1)</script>'),
      bytesOf('%PDF-1.7'),
      bytesOf('RIFF', [0, 0, 0, 0], 'WAVEfmt '),
      bytesOf([0, 0, 2, 0, 1, 0]),
      bytesOf([0, 0, 1, 0, 0, 0]),
      bytesOf([0x89], 'PNX'),
      bytesOf([0xe9, 0x3c]),
      new Uint8Array(),
    ]) {
      expect(pictureOf(bytes)).toBeUndefined();
    }
  });

  test('weighs at most 64 KB', () => {
    const sized = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(PNG);
      return bytes;
    };
    expect(pictureOf(sized(PICTURE_BYTES))?.type).toBe('image/png');
    expect(pictureOf(sized(PICTURE_BYTES + 1))).toBeUndefined();
  });
});

describe('where a site keeps its icon', () => {
  const PAGE = 'https://www.brand.example/en/';
  const SITE = 'https://brand.example/';
  const TOUCH = 'https://brand.example/apple-touch-icon.png';
  const FAVICON = 'https://brand.example/favicon.ico';
  const CONVENTIONAL = [TOUCH, FAVICON];

  test('the smallest it names of at least 64 pixels, then one that scales, then the largest of the rest', () => {
    expect(
      iconLocations(
        [
          { rel: 'icon', href: '/favicon-16.png', sizes: '16x16' },
          { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
          { rel: 'shortcut icon', href: '/favicon.ico' },
          { rel: 'icon', href: '/favicon-32.png', sizes: '32x32' },
          { rel: 'icon', href: '/icon-512.png', sizes: '512x512' },
          { rel: 'apple-touch-icon', href: 'touch.png' },
          { rel: 'icon', href: '/icon-96.png', sizes: '48x48 96x96' },
        ],
        PAGE,
        SITE,
      ),
    ).toEqual([
      'https://www.brand.example/icon-96.png',
      'https://www.brand.example/en/touch.png',
      'https://www.brand.example/icon-512.png',
      'https://www.brand.example/icon.svg',
      'https://www.brand.example/favicon-32.png',
      'https://www.brand.example/favicon-16.png',
      'https://www.brand.example/favicon.ico',
      ...CONVENTIONAL,
    ]);
  });

  test('then where sites keep one by convention, at the root of the site it asked', () => {
    expect(iconLocations([], PAGE, SITE)).toEqual(CONVENTIONAL);
    expect(
      iconLocations(
        [],
        'https://127.0.0.1:4443/sites/brand.test/',
        'https://127.0.0.1:4443/sites/brand.test/',
      ),
    ).toEqual([
      'https://127.0.0.1:4443/sites/brand.test/apple-touch-icon.png',
      'https://127.0.0.1:4443/sites/brand.test/favicon.ico',
    ]);
    // Named by the page as well, it is asked for once.
    expect(
      iconLocations([{ rel: 'icon', href: 'https://brand.example/favicon.ico' }], PAGE, SITE),
    ).toEqual([FAVICON, TOUCH]);
  });

  test('never a link that isn’t an icon, or isn’t over HTTPS', () => {
    expect(
      iconLocations(
        [
          { rel: 'stylesheet', href: '/site.css' },
          { rel: 'mask-icon', href: '/mask.svg' },
          { rel: 'icon', href: 'http://brand.example/plain.png', sizes: '96x96' },
          { rel: 'icon', href: 'data:image/png;base64,AAAA', sizes: '96x96' },
          { rel: 'icon', href: 'javascript:alert(1)' },
          { rel: 'ICON', href: '  /shouted.png  ', sizes: '64X64' },
        ],
        PAGE,
        SITE,
      ),
    ).toEqual(['https://www.brand.example/shouted.png', ...CONVENTIONAL]);
  });
});

describe('what DNS says', () => {
  test('a TXT record’s quoted strings join into one, with their escapes read', () => {
    expect(txtOf('"v=BIMI1; l=https://brand.example/logo.svg"')).toBe(
      'v=BIMI1; l=https://brand.example/logo.svg',
    );
    expect(txtOf('"v=DMARC1; p=reject; " "rua=mailto:d@brand.example"')).toBe(
      'v=DMARC1; p=reject; rua=mailto:d@brand.example',
    );
    expect(txtOf('"a \\"quoted\\" word\\059 and\\032space"')).toBe('a "quoted" word; and space');
    expect(txtOf('v=DMARC1; p=none')).toBe('v=DMARC1; p=none');
  });

  test('a DMARC record gives its policies, its share and whether it is a public suffix', () => {
    expect(dmarcOf(['v=DMARC1; p=reject; rua=mailto:d@brand.example'])).toEqual({
      p: 'reject',
      pct: 100,
      psd: false,
    });
    expect(dmarcOf(['v=DMARC1;p=Quarantine;sp=none;pct=50;psd=y'])).toEqual({
      p: 'quarantine',
      sp: 'none',
      pct: 50,
      psd: true,
    });
    expect(dmarcOf(['v=DMARC1; rua=mailto:d@brand.example'])).toMatchObject({ p: 'none' });
    expect(dmarcOf(['v=DMARC1; p=reject; pct=nonsense'])?.pct).toBe(100);
  });

  test('no DMARC record, or more than one, is none', () => {
    expect(dmarcOf([])).toBeUndefined();
    expect(dmarcOf(['v=spf1 -all', 'google-site-verification=abc'])).toBeUndefined();
    expect(dmarcOf(['v=DMARC1; p=reject', 'v=DMARC1; p=none'])).toBeUndefined();
    expect(dmarcOf(['v=dmarc1; p=reject'])).toBeUndefined();
  });

  test('a BIMI record names its logo only over HTTPS, and declines with an empty location', () => {
    expect(bimiOf(['v=BIMI1; l=https://brand.example/logo.svg; a=;'])).toEqual({
      logo: 'https://brand.example/logo.svg',
    });
    expect(bimiOf(['v=BIMI1; l=https://a.example/1.svg,https://b.example/2.svg'])).toEqual({
      logo: 'https://a.example/1.svg',
    });
    expect(bimiOf(['v=BIMI1; l=; a=;'])).toEqual({});
    expect(bimiOf(['v=BIMI1;'])).toEqual({});
    expect(bimiOf(['v=BIMI1; l=http://brand.example/logo.svg'])).toEqual({});
    expect(bimiOf(['v=BIMI1; l=javascript:alert(1)'])).toEqual({});
  });

  test('no BIMI record, or more than one, is none', () => {
    expect(bimiOf([])).toBeUndefined();
    expect(bimiOf(['v=spf1 -all'])).toBeUndefined();
    expect(
      bimiOf(['v=BIMI1; l=https://a.example/1.svg', 'v=BIMI1; l=https://b.example/2.svg']),
    ).toBeUndefined();
  });

  test('a lookup walks from a sender’s domain up to its last two labels, at most five', () => {
    expect(walkOf('brand.example')).toEqual(['brand.example']);
    expect(walkOf('email.brand.example')).toEqual(['email.brand.example', 'brand.example']);
    expect(walkOf('news.brand.co.uk')).toEqual(['news.brand.co.uk', 'brand.co.uk', 'co.uk']);
    expect(walkOf('a.b.c.d.e.brand.example')).toEqual([
      'a.b.c.d.e.brand.example',
      'c.d.e.brand.example',
      'd.e.brand.example',
      'e.brand.example',
      'brand.example',
    ]);
    expect(walkOf('localhost')).toEqual(['localhost']);
  });

  test('the organizational domain is the highest with a record, or the one below a public suffix', () => {
    const reject: Dmarc = { p: 'reject', pct: 100, psd: false };
    const walk = ['news.brand.example', 'brand.example'];
    expect(organizationalOf(walk, new Map([['brand.example', reject]]))).toBe('brand.example');
    expect(
      organizationalOf(
        walk,
        new Map([
          ['news.brand.example', reject],
          ['brand.example', reject],
        ]),
      ),
    ).toBe('brand.example');
    expect(organizationalOf(walk, new Map([['news.brand.example', reject]]))).toBe(
      'news.brand.example',
    );
    expect(organizationalOf(walk, new Map())).toBe('news.brand.example');
    const suffix = ['alice.hosted.example', 'hosted.example'];
    expect(organizationalOf(suffix, new Map([['hosted.example', { ...reject, psd: true }]]))).toBe(
      'alice.hosted.example',
    );
  });
});

describe('a domain held to DMARC', () => {
  const record = (p: Dmarc['p'], more: Partial<Dmarc> = {}): Dmarc => ({
    p,
    pct: 100,
    psd: false,
    ...more,
  });

  test('is one whose own policy quarantines or rejects all failing mail', () => {
    expect(enforces(record('reject'), record('reject'))).toBe(true);
    expect(enforces(record('quarantine'), record('quarantine'))).toBe(true);
    expect(enforces(record('reject'), undefined)).toBe(true);
  });

  test('is not one whose policy is none, or covers only part of its failing mail', () => {
    expect(enforces(record('none'), record('none'))).toBe(false);
    expect(enforces(record('reject', { pct: 99 }), record('reject', { pct: 99 }))).toBe(false);
    expect(enforces(undefined, undefined)).toBe(false);
  });

  test('without a record of its own, takes its organizational domain’s policy for those under it', () => {
    expect(enforces(undefined, record('reject'))).toBe(true);
    expect(enforces(undefined, record('reject', { sp: 'quarantine' }))).toBe(true);
    expect(enforces(undefined, record('reject', { sp: 'none' }))).toBe(false);
    expect(enforces(undefined, record('none', { sp: 'reject' }))).toBe(false);
  });

  test('needs its organizational domain to enforce too, whatever its own record says', () => {
    expect(enforces(record('reject'), record('none'))).toBe(false);
    expect(enforces(record('reject'), record('reject', { pct: 10 }))).toBe(false);
  });
});

describe('a logo Trail Mix keeps', () => {
  const svg = (inside = '', open = '<svg xmlns="http://www.w3.org/2000/svg">') =>
    `${open}<title>Brand</title><rect width="64" height="64" fill="url(#g)"/>${inside}</svg>`;

  test('is an SVG drawn from shapes, as the demo’s and BIMI’s are', () => {
    for (const pictures of Object.values(DEMO_PICTURES)) {
      for (const picture of Object.values(pictures)) expect(isSafeLogo(picture)).toBe(true);
    }
    expect(isSafeLogo(svg())).toBe(true);
    expect(isSafeLogo(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Brand -->\n${svg()}`)).toBe(
      true,
    );
    expect(
      isSafeLogo(
        `\uFEFF<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${svg('<use href="#g"/>')}`,
      ),
    ).toBe(true);
  });

  test('weighs at most 32 KB', () => {
    const padding = (bytes: number) => `<desc>${'x'.repeat(bytes)}</desc>`;
    const size = new TextEncoder().encode(svg()).byteLength + '<desc></desc>'.length;
    expect(isSafeLogo(svg(padding(LOGO_BYTES - size)))).toBe(true);
    expect(isSafeLogo(svg(padding(LOGO_BYTES - size + 1)))).toBe(false);
  });

  test('is never one that could run, embed a document or reach outside itself', () => {
    for (const inside of [
      '<script>alert(1)</script>',
      '<SCRIPT href="x.js"/>',
      '<foreignObject><iframe src="https://evil.example"/></foreignObject>',
      '<rect onclick="alert(1)"/>',
      '<a href="javascript:alert(1)"><rect/></a>',
      '<image href="https://tracker.example/pixel.png"/>',
      '<image xlink:href="data:image/png;base64,AAAA"/>',
      '<rect style="fill: url(https://tracker.example/x)"/>',
      '<style>@import "https://evil.example/x.css";</style>',
      '<embed src="x"/>',
      '<object data="x"/>',
    ]) {
      expect(isSafeLogo(svg(inside))).toBe(false);
    }
    expect(isSafeLogo(svg('', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'))).toBe(
      false,
    );
    expect(isSafeLogo(`<!DOCTYPE svg [<!ENTITY lol "lol">]>${svg('&lol;')}`)).toBe(false);
  });

  test('is an SVG document, not a page or a picture of another kind', () => {
    expect(isSafeLogo('<!doctype html><html><body><svg></svg></body></html>')).toBe(false);
    expect(isSafeLogo('<html><svg></svg></html>')).toBe(false);
    expect(isSafeLogo('GIF89a')).toBe(false);
    expect(isSafeLogo('')).toBe(false);
  });
});

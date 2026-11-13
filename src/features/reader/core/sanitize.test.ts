import { expect, test } from 'bun:test';
import { FIRST_PART, frameDocument, type FrameLook, type SafeMail } from './sanitize.ts';

const look: FrameLook = {
  colorScheme: 'light',
  paper: 'white',
  ink: 'black',
  link: 'blue',
  lightInk: 'black',
  lightLink: 'blue',
  font: '16px/1.5 serif',
  monospace: 'monospace',
  quotes: 'folded',
};

const mail = (html: string): SafeMail => ({
  html,
  blockedImages: false,
  trackers: 0,
  paper: 'theme',
  quote: false,
  inlineParts: [],
  sources: [],
});

/** A paragraph of about 50 characters, repeated to `size`. */
const paragraphs = (size: number) =>
  '<p>A paragraph of the long middle, at its own pace.</p>'.repeat(Math.ceil(size / 50));

test('short mail is written whole, in one part', () => {
  const { start, rest } = frameDocument(mail('<p>Lunch on Thursday?</p>'), look);
  expect(start).toEndWith('<body><p>Lunch on Thursday?</p></body></html>');
  expect(rest).toBe('');
});

test('long mail is cut at the first tag past its first part, and the parts make the whole', () => {
  const html = `<p>The start.</p>${paragraphs(FIRST_PART * 4)}<p>The end.</p>`;
  const { start, rest } = frameDocument(mail(html), look);
  const body = start.slice(start.indexOf('<body>') + '<body>'.length);
  expect(body.length).toBeGreaterThanOrEqual(FIRST_PART);
  expect(body.length).toBeLessThan(FIRST_PART + 60);
  expect(rest).toStartWith('<');
  expect(rest).toEndWith('<p>The end.</p></body></html>');
  expect(body + rest).toBe(`${html}</body></html>`);
});

test('long mail is cut past every style it sets, so its start shows styled as it stays', () => {
  const style = '<style>p { color: teal }</style>';
  const html = `${paragraphs(FIRST_PART * 1.5)}${style}${paragraphs(FIRST_PART * 3)}`;
  const { start, rest } = frameDocument(mail(html), look);
  expect(start).toContain(style);
  expect(rest).not.toContain('<style');
  expect(rest).toStartWith('<');
});

test('long mail whose styles come late is written whole', () => {
  const html = `${paragraphs(FIRST_PART * 3)}<style>p { color: teal }</style><p>The end.</p>`;
  expect(frameDocument(mail(html), look).rest).toBe('');
});

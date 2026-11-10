import { expect, test } from 'bun:test';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { DraftImage, DraftParagraph } from './draftImage.ts';

/** The editor's Markdown, with the extensions that read images and paragraphs. */
const markdown = new MarkdownManager({
  extensions: [StarterKit.configure({ paragraph: false }), DraftParagraph, DraftImage],
});

type Json = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Json[] };
const nodesOf = (json: Json): Json[] => [json, ...(json.content ?? []).flatMap(nodesOf)];
const read = (text: string) => nodesOf(markdown.parse(text) as Json);

test('what was written reads back as written', () => {
  for (const text of [
    'See you **Thursday** at noon.',
    'First line\n\n- one\n- two',
    'The chart:\n\n![chart](cid:chart@trailmix.invalid)',
  ]) {
    expect(markdown.serialize(markdown.parse(text)).trim()).toBe(text);
  }
});

test('an image the draft carries by cid: is an image', () => {
  const images = read('The chart: ![chart](cid:chart@trailmix.invalid)').filter(
    ({ type }) => type === 'image',
  );
  expect(images.map(({ attrs }) => attrs?.['src'])).toEqual(['cid:chart@trailmix.invalid']);
});

test('an image by any other address stays its words, among others and on a line of its own', () => {
  for (const text of [
    'See ![pixel](https://tracker.example/p.png) here',
    '![pixel](http://127.0.0.1:8080/p.png "Pixel")',
    '![pixel](data:image/png;base64,iVBORw0KGgo=)',
  ]) {
    const nodes = read(text);
    expect({ text, images: nodes.filter(({ type }) => type === 'image').length }).toEqual({
      text,
      images: 0,
    });
    const words = nodes.flatMap((node) => (node.type === 'text' ? [node.text] : [])).join('');
    expect(words).toBe(text);
    // Every word lies in a paragraph, as the editor's document requires.
    expect(markdown.parse(text).content?.every(({ type }) => type === 'paragraph')).toBe(true);
  }
});

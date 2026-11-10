import Paragraph from '@tiptap/extension-paragraph';
import Image from '@tiptap/extension-image';

/**
 * The editor's images: only those the draft carries, by `cid:`. A pasted, dropped or picked image
 * travels with the draft and is named by its Content-ID. An image by any other address is foreign
 * to the draft, and loading it in Trail Mix's own page would tell its sender the draft was opened.
 *
 * So nothing else becomes an image node, whichever way it arrives. Pasted HTML's other images are
 * left out. Markdown's `![…](…)` by any other address stays the words it is, since dropping them
 * would lose what the member wrote.
 */
export const isDraftImage = (src: string | null | undefined) => /^cid:/i.test(src?.trim() ?? '');

/**
 * An image node that shows only what the draft holds, as `imageUrl` resolves it. Its `src` stays
 * the `cid:` the Markdown saves, and only the page's `<img>` loads from where `imageUrl` says.
 *
 * Wherever the editor writes an image out as HTML, as it does on copying and as it tears down, its
 * address goes in `data-draft-src`, which the page never loads.
 */
export const DraftImage = Image.extend<{
  imageUrl: (contentId: string) => string | undefined;
  /** Each image's way to look its source up again, while it is in the editor. */
  shown: Set<() => void>;
  /** The class each image is drawn with. */
  className: string;
}>({
  parseHTML() {
    return [{ tag: 'img[data-draft-src^="cid:" i]' }, { tag: 'img[src^="cid:" i]' }];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-draft-src') ?? element.getAttribute('src'),
        renderHTML: (attributes) => ({ 'data-draft-src': String(attributes['src'] ?? '') }),
      },
    };
  },
  parseMarkdown: (token, helpers) => {
    const src = String(token['href'] ?? '');
    if (!isDraftImage(src)) return helpers.createTextNode(String(token.raw ?? ''));
    const title = typeof token['title'] === 'string' ? token['title'] : null;
    return helpers.createNode('image', { src, title, alt: String(token.text ?? '') });
  },
  addOptions() {
    return { ...this.parent?.(), imageUrl: () => undefined, shown: new Set(), className: '' };
  },
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement('img');
      image.className = this.options.className;
      let current = node;
      const show = () => {
        const src = String(current.attrs['src'] ?? '');
        const contentId = /^cid:(.+)$/i.exec(src)?.[1];
        const url = contentId ? this.options.imageUrl(contentId) : undefined;
        if (!url) image.removeAttribute('src');
        else if (image.getAttribute('src') !== url) image.src = url;
        image.alt = String(current.attrs['alt'] ?? '');
      };
      show();
      this.options.shown.add(show);
      return {
        dom: image,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          show();
          return true;
        },
        destroy: () => this.options.shown.delete(show),
      };
    };
  },
});

/**
 * A paragraph. One that is nothing but an image by another address, which Markdown parses as the
 * image alone, keeps its words as the paragraph's text.
 */
export const DraftParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const [only, ...rest] = token.tokens ?? [];
    if (rest.length === 0 && only?.type === 'image' && !isDraftImage(String(only['href'] ?? ''))) {
      return helpers.createNode('paragraph', undefined, [
        helpers.createTextNode(String(only.raw ?? '')),
      ]);
    }
    return this.parent?.(token, helpers) ?? [];
  },
});

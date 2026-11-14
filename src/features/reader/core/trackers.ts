/**
 * Tracking pixels: images in a message only to tell its sender when it was opened, and from where.
 * The sanitizer drops them as it walks the message, before anything loads, whether or not the member
 * allows the sender's images, and counts them for the message's sheet.
 *
 * An image that would load from a server is a tracker when
 * - its address is a mail service's open-tracking address, listed here;
 * - it is too small to see, 2 pixels or less across and down, by its attributes or its own style;
 * - or it is hidden, by its own inline style or an ancestor's, or by `hidden`, and no rule of the
 *   message's own styles could show it, as a logo for dark mode or a picture for phones is shown.
 * A wide spacer, such as 600 by 1, is not small, and stays.
 */

/** One service's open-tracking addresses: a host and its subdomains, a path, or both. */
type Tracking = { host?: string | RegExp; path?: RegExp };

/**
 * Written for Trail Mix from how each service builds the address of its open pixel. A path alone
 * matches on any host, since senders put a service's tracking behind a domain of their own and the
 * path comes with it. A host alone serves nothing but tracking.
 */
const TRACKING: readonly Tracking[] = [
  // Mailchimp and Mandrill, on list-manage.com, mandrillapp.com or a sender's own domain.
  { path: /^\/track\/open\.php$/ },
  // SendGrid.
  { path: /^\/wf\/open$/ },
  // Salesforce Marketing Cloud, whose own hosts serve senders' pictures too.
  { path: /^\/open\.aspx$/i },
  // HubSpot's marketing mail, then its sales mail.
  { path: /^\/Cto\// },
  { path: /^\/e\dt\/o\// },
  // Customer.io, whose own domain serves senders' pictures too.
  { path: /^\/e\/o\/[\w=-]{20,}/ },
  // Brevo, once Sendinblue.
  { path: /^\/tr\/op\// },
  // Mailgun, on the `email.` host a sender points at it.
  { host: /^email\./, path: /^\/o\/[\w=-]{20,}/ },
  // Mailjet.
  { host: 'mjt.lu', path: /^\/oo\// },
  // Constant Contact.
  { host: 'rs6.net', path: /^\/on\.jsp$/ },
  // Substack.
  { host: 'eotrx.substackcdn.com', path: /^\/open/ },
  // Mailtrack's read receipts, from a site that also has pictures of its own.
  { host: 'mailtrack.io', path: /^\/trace\// },
  // Amazon SES.
  { host: 'awstrack.me' },
  // Postmark.
  { host: 'pstmrk.it' },
  // Klaviyo.
  { host: /(?:^|\.)klclick\d?\.com$/ },
  // SparkPost.
  { host: 'spgo.io' },
  // Kit, once ConvertKit.
  { host: /^open\.convertkit-mail\d*\.com$/ },
  // Google Analytics, which some senders count opens with.
  { host: 'google-analytics.com' },
  // Read receipts: Superhuman, Streak and Yesware.
  { host: 'r.superhuman.com' },
  { host: 'mailfoogae.appspot.com' },
  { host: 't.yesware.com' },
];

/** Whether an image's address is a service's open-tracking address. */
export function isTrackingAddress(url: URL): boolean {
  const host = url.hostname;
  return TRACKING.some(
    (tracking) =>
      (tracking.host === undefined ||
        (typeof tracking.host === 'string'
          ? host === tracking.host || host.endsWith(`.${tracking.host}`)
          : tracking.host.test(host))) &&
      (tracking.path === undefined || tracking.path.test(url.pathname)),
  );
}

/**
 * A length in pixels, from an attribute such as `width="1"` or a style's value such as `1px`, or
 * undefined for one that depends on more, such as `100%` or `auto`.
 */
function pixels(value: string | null): number | undefined {
  const match = /^\s*(\d*\.?\d+)\s*(?:px)?\s*$/i.exec(value ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** How large an image is drawn on one axis, when its own attributes and style decide it. */
function extent(image: HTMLElement, axis: 'width' | 'height'): number | undefined {
  const styled = image.style.getPropertyValue(axis);
  const size = styled ? pixels(styled) : pixels(image.getAttribute(axis));
  const most = pixels(image.style.getPropertyValue(`max-${axis}`));
  return most !== undefined && (size === undefined || most < size) ? most : size;
}

/** The longest an image may be on both axes and still be a tracker, in pixels. */
const PIXEL = 2;

/** Whether a declaration hides what it is set on. */
function conceals(property: string, value: string): boolean {
  switch (property) {
    case 'display':
      return value === 'none';
    case 'visibility':
      return value === 'hidden' || value === 'collapse';
    case 'opacity':
      return value !== '' && Number.parseFloat(value) === 0;
    case 'overflow':
      return /hidden|clip/.test(value);
    default:
      return pixels(value) === 0;
  }
}

const HIDING = ['display', 'visibility', 'opacity'] as const;
const EXTENTS = ['width', 'height', 'max-width', 'max-height'] as const;
// A style that could hide, found before any style is parsed. Most elements' styles can't.
const MAY_HIDE = /(?:display|visibility|opacity|width|height)\s*:\s*(?:none|hidden|collapse|0)/i;

/** How an element hides what it holds, and whether `!important` keeps it hidden whatever comes. */
type Concealment = { properties: string[]; locked: boolean };

function concealment(element: HTMLElement, image: boolean): Concealment | undefined {
  const style = element.style;
  const properties: string[] = [];
  let locked = false;
  const hides = (property: string) => {
    properties.push(property);
    if (style.getPropertyPriority(property) === 'important') locked = true;
  };
  if (element.hasAttribute('hidden') && !style.getPropertyValue('display')) {
    properties.push('display');
  }
  for (const property of HIDING) {
    if (conceals(property, style.getPropertyValue(property))) hides(property);
  }
  if (image) {
    for (const axis of ['width', 'height'] as const) {
      if (extent(element, axis) === 0) [axis, `max-${axis}`].forEach(hides);
    }
  } else if (conceals('overflow', style.getPropertyValue('overflow'))) {
    const zero = EXTENTS.filter((property) => conceals(property, style.getPropertyValue(property)));
    if (zero.length) [...zero, 'overflow'].forEach(hides);
  }
  return properties.length ? { properties, locked } : undefined;
}

/** A rule of the message's styles that could show what an inline style hides. */
type Revealer = { selector: string; shows: Set<string> };

function revealers(css: Iterable<string>): Revealer[] {
  const found: Revealer[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const style = rule.style;
        const shows = new Set(
          [...HIDING, ...EXTENTS, 'overflow'].filter((property) => {
            const value = style.getPropertyValue(property);
            // Only `!important` outweighs a style set on the element itself.
            return (
              value !== '' &&
              !conceals(property, value) &&
              style.getPropertyPriority(property) === 'important'
            );
          }),
        );
        if (shows.size) found.push({ selector: rule.selectorText, shows });
      } else if (rule instanceof CSSGroupingRule) {
        // Every condition counts, since a rule for phones or for dark mode shows it somewhere.
        walk(rule.cssRules);
      }
    }
  };
  for (const text of css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    walk(sheet.cssRules);
  }
  return found;
}

/**
 * Whether the images of one message would go unseen, asked of each as the sanitizer reaches it:
 * after its ancestors are sanitized, and before its own attributes are. `css` gives the message's
 * style sheets as it wrote them, and is read only once some image is hidden.
 */
export function unseenImages(css: (document: Document) => Iterable<string>) {
  // Whether an element, or one it lies inside, hides what it holds.
  const hiding = new WeakMap<Element, boolean>();
  let shown: Revealer[] | undefined;

  const hidden = (element: HTMLElement, image: boolean): boolean => {
    const concealed = concealment(element, image);
    if (!concealed) return false;
    if (concealed.locked) return true;
    shown ??= revealers(css(element.ownerDocument));
    return !shown.some(
      ({ selector, shows }) =>
        concealed.properties.some((property) => shows.has(property)) && matches(element, selector),
    );
  };

  const hides = (element: Element | null): boolean => {
    if (!(element instanceof HTMLElement)) return false;
    let known = hiding.get(element);
    if (known === undefined) {
      const style = element.getAttribute('style');
      known =
        ((element.hasAttribute('hidden') || (style !== null && MAY_HIDE.test(style))) &&
          hidden(element, false)) ||
        hides(element.parentElement);
      hiding.set(element, known);
    }
    return known;
  };

  return (image: HTMLElement): boolean => {
    const [width, height] = [extent(image, 'width'), extent(image, 'height')];
    if (width !== undefined && height !== undefined && width <= PIXEL && height <= PIXEL) {
      return true;
    }
    return hidden(image, true) || hides(image.parentElement);
  };
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    // A selector a style sheet keeps but `matches` refuses.
    return false;
  }
}

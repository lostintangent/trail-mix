/**
 * Reports each class the first time it lands on an element of the page, as the page builds and
 * changes. `suite.ts` adds it to each context the e2e suites open, along with the binding it
 * reports through. It runs in the page, so it must stay self-contained.
 */
export function reportClasses(binding: string) {
  // A message's frame is the sender's HTML, which Astryx never styles.
  if (window.top !== window) return;
  const seen = new Set<string>();
  const report = (names: string[]) =>
    (window as unknown as Record<string, (names: string[]) => Promise<void>>)[binding]?.(names);
  new MutationObserver((records) => {
    const fresh: string[] = [];
    const look = (element: Element) => {
      for (const name of element.classList) {
        if (seen.has(name)) continue;
        seen.add(name);
        fresh.push(name);
      }
    };
    for (const record of records) {
      if (record.target instanceof Element) look(record.target);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        look(node);
        for (const element of node.querySelectorAll('[class]')) look(element);
      }
    }
    if (fresh.length) void report(fresh);
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}

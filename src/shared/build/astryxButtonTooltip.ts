import { fileURLToPath } from 'node:url';
import { parseAst, type Plugin } from 'vite';

const DIST = '/@astryxdesign/core/dist/';
const BUTTON = `${DIST}Button/Button.js`;
const SOURCE = '../Tooltip/useTooltip.js';
const HOOK = 'useTooltip';
/** What the later hook gives `Button`, so the build fails if `Button` reads anything else. */
const READ = new Set(['ref', 'describedBy', 'renderTooltip']);
/** Astryx's tooltip code and the layer it opens, which the first screen does without. */
const LATER = [`${DIST}Tooltip/useTooltip.js`, `${DIST}Layer/useLayer.js`];
/** The app's hook, which loads the real one once the first screen has settled. */
const LATER_TOOLTIP = fileURLToPath(new URL('../LaterTooltip.tsx', import.meta.url));

/**
 * Every Astryx `Button` calls Astryx's `useTooltip`, tooltip or none, so the tooltip's code and the
 * layer it opens, about 15 KB gzip, come to the first screen with its first button, though no
 * tooltip shows until a hover or a focus rests. This gives `Button` the app's `useLaterTooltip` in
 * its place, which loads the real hook once the first screen has settled, or as soon as a pointer
 * or focus reaches a button, and runs it for each button from then on.
 *
 * The build fails if `Button.js` changes so the swap can't be made, if `Button` reads more of the
 * hook than the later hook gives, or if the chunk that holds `Button` loads the tooltip's code
 * anyway.
 */
export function astryxButtonTooltip(): Plugin {
  return {
    name: 'astryx-button-tooltip',
    apply: 'build',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    transform(code, id) {
      if (!id.endsWith(BUTTON)) return null;
      try {
        return { code: laterButtonTooltip(code, LATER_TOOLTIP), map: null };
      } catch (error) {
        return this.error(String(error));
      }
    },
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? [output] : [],
      );
      const holding = (end: string) =>
        chunks.filter((chunk) =>
          Object.entries(chunk.modules).some(
            ([id, rendered]) => id.endsWith(end) && rendered.renderedLength > 0,
          ),
        );
      const [first] = holding(BUTTON);
      if (!first) return;
      const loaded = new Set<string>();
      const next = [first.fileName];
      for (let name = next.pop(); name !== undefined; name = next.pop()) {
        if (loaded.has(name)) continue;
        loaded.add(name);
        const output = bundle[name];
        if (output?.type === 'chunk') next.push(...output.imports);
      }
      for (const end of LATER) {
        const tooltip = holding(end).find((chunk) => loaded.has(chunk.fileName));
        if (tooltip) {
          this.error(
            `Astryx's ${end.slice(DIST.length)} is in ${tooltip.fileName}, which loads with ` +
              'Button.js, so the tooltip is back on the first load.',
          );
        }
      }
    },
  };
}

/**
 * Astryx's `Button.js`, importing its tooltip hook from `from` rather than from Astryx. Throws if
 * it no longer imports `useTooltip` once, or reads of the hook's result more than `READ` holds.
 */
export function laterButtonTooltip(code: string, from: string): string {
  const program = parseAst(code);
  const imports = program.body.flatMap((node) =>
    node.type === 'ImportDeclaration' && node.source.value === SOURCE ? [node] : [],
  );
  const [statement] = imports;
  const [specifier] = statement?.specifiers ?? [];
  if (
    imports.length !== 1 ||
    statement?.specifiers.length !== 1 ||
    specifier?.type !== 'ImportSpecifier' ||
    specifier.imported.type !== 'Identifier' ||
    specifier.imported.name !== HOOK
  ) {
    throw new Error(`Astryx's Button.js no longer imports ${HOOK} alone from ${SOURCE}.`);
  }
  const hook = specifier.local.name;

  // Every name the hook's result is kept under, and each way the file reads one.
  const results = new Set<string>();
  const reads: { name: string; parent: Node; node: Node }[] = [];
  walk(program, null, (node, parent) => {
    if (
      node.type === 'VariableDeclarator' &&
      (node.init as Node | null)?.type === 'CallExpression' &&
      ((node.init as Node).callee as Node).type === 'Identifier' &&
      ((node.init as Node).callee as Node).name === hook
    ) {
      const id = node.id as Node;
      if (id.type !== 'Identifier') {
        throw new Error(`Astryx's Button no longer keeps what ${HOOK} returns under one name.`);
      }
      results.add(id.name as string);
    }
    if (node.type === 'Identifier' && parent)
      reads.push({ name: node.name as string, parent, node });
  });
  if (results.size !== 1) {
    throw new Error(`Astryx's Button no longer calls ${HOOK} once.`);
  }
  for (const { name, parent, node } of reads) {
    if (!results.has(name)) continue;
    if (parent.type === 'VariableDeclarator' && parent.id === node) continue;
    const isMember = parent.type === 'MemberExpression' && !parent.computed;
    // A property of something else that shares the name.
    if (isMember && parent.property === node) continue;
    if (
      parent.type === 'Property' &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand
    ) {
      continue;
    }
    const property = isMember ? (parent.property as Node) : null;
    if (property?.type !== 'Identifier' || !READ.has(property.name as string)) {
      throw new Error(
        `Astryx's Button reads ${code.slice(parent.start, parent.end)}, which the later ` +
          `${HOOK} doesn't give it.`,
      );
    }
  }

  return (
    code.slice(0, statement.start) +
    `import { useLaterTooltip as ${hook} } from ${JSON.stringify(from)};` +
    code.slice(statement.end)
  );
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };

/** Visits `node` and every node inside it, with the node it lies in. */
function walk(
  node: unknown,
  parent: Node | null,
  visit: (node: Node, parent: Node | null) => void,
) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, parent, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const isNode = typeof (node as Node).type === 'string';
  if (isNode) visit(node as Node, parent);
  for (const value of Object.values(node)) walk(value, isNode ? (node as Node) : parent, visit);
}

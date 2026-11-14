import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst, type Plugin } from 'vite';

const DIST = '/@astryxdesign/core/dist/';
const CLEARANCE = `${DIST}Layer/useLayerKeyboardClearance.js`;
const KEYBOARD = `${DIST}keyboard/keyboardHeight.js`;
/** The query that names the effect's own module, read from the file it was cut from. */
export const EFFECT = '?effect';
const HOOK = 'useLayerKeyboardClearance';
const EFFECT_HOOK = 'useIsomorphicLayoutEffect';
/** The names the cut adds to the file, which Astryx's own code must not already use. */
const ADDED = [
  'clearance$',
  'loading$',
  'loadClearance$',
  'preloading$',
  'preloadClearance$',
  'arrived$',
  'setArrived$',
  'useState$',
  'afterFirstScreen$',
];
/** The app's own moment for code the first screen does without. */
const AFTER_FIRST_SCREEN = fileURLToPath(new URL('../afterFirstScreen.ts', import.meta.url));
const RELATIVE = /from (["'])(\.\.?\/[^"']+)\1/g;

/**
 * Every layer calls Astryx's `useLayerKeyboardClearance`, which keeps an anchored layer clear of a
 * phone's software keyboard while it is open. Its effect reads the keyboard through Astryx's
 * keyboard model, about 6 KB gzip with the selection and click code it reaches, and `Button` brings
 * a layer to the first screen for its tooltip, though no layer opens there. This cuts the effect
 * into a module of its own, which loads once the first screen has settled, as the app's other later
 * code does, or as soon as a layer opens before then, and which a layer runs once it arrives. The
 * keyboard's height is measured when asked for, so code that arrives with the keyboard already up
 * still finds it.
 *
 * The build fails if `useLayerKeyboardClearance.js` changes so the cut can't be made, or if the
 * chunk that holds what stays of it loads the keyboard's code anyway.
 */
export function astryxKeyboardClearance(): Plugin {
  return {
    name: 'astryx-keyboard-clearance',
    apply: 'build',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    load(id) {
      if (!id.endsWith(CLEARANCE + EFFECT)) return null;
      const file = id.slice(0, -EFFECT.length);
      try {
        const { effect } = splitKeyboardClearance(readFileSync(file, 'utf8'));
        // Its imports name their files outright, since its own id carries a query.
        return effect.replace(RELATIVE, (_, quote: string, path: string) => {
          return `from ${quote}${resolve(dirname(file), path)}${quote}`;
        });
      } catch (error) {
        return this.error(String(error));
      }
    },
    transform(code, id) {
      if (!id.endsWith(CLEARANCE)) return null;
      try {
        return { code: splitKeyboardClearance(code).rest, map: null };
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
      const [first] = holding(CLEARANCE);
      if (!first) return;
      const loaded = new Set<string>();
      const next = [first.fileName];
      for (let name = next.pop(); name !== undefined; name = next.pop()) {
        if (loaded.has(name)) continue;
        loaded.add(name);
        const output = bundle[name];
        if (output?.type === 'chunk') next.push(...output.imports);
      }
      const keyboard = holding(KEYBOARD).find((chunk) => loaded.has(chunk.fileName));
      if (keyboard) {
        this.error(
          `Astryx's keyboard code is in ${keyboard.fileName}, which loads with ` +
            'useLayerKeyboardClearance.js, so it is back on the first load.',
        );
      }
    },
  };
}

/**
 * Cuts the layout effect out of Astryx's `useLayerKeyboardClearance`. What stays keeps the hook,
 * its state and every export. Its own effect has the effect's module load once the first screen
 * has settled, or at once while its layer is open, then runs the effect from there with the hook's
 * names, at the moments it ran before.
 * The effect's module keeps the file's imports and helpers, with the hook replaced by
 * `clearKeyboard`, which runs the effect. Throws if the hook no longer takes `(isOpen, …)`, or has
 * no one effect to cut.
 */
export function splitKeyboardClearance(code: string): { rest: string; effect: string } {
  const taken = ADDED.find((name) => code.includes(name));
  if (taken) throw new Error(`Astryx's ${HOOK}.js already names ${taken}, which the cut adds.`);
  const program = parseAst(code);
  const exported = program.body.filter(
    (node) =>
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === HOOK,
  );
  const [declaration] = exported;
  const hook = declaration?.type === 'ExportNamedDeclaration' ? declaration.declaration : null;
  if (!declaration || exported.length !== 1 || hook?.type !== 'FunctionDeclaration' || !hook.body) {
    throw new Error(`Astryx's ${HOOK}.js no longer exports one ${HOOK} function to cut.`);
  }
  const [open] = hook.params;
  if (open?.type !== 'Identifier' || open.name !== 'isOpen') {
    throw new Error(`Astryx's ${HOOK} no longer takes isOpen first, which says when to load.`);
  }

  const statements = hook.body.body;
  const effects = statements.filter(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.type === 'Identifier' &&
      node.expression.callee.name === EFFECT_HOOK,
  );
  const [statement] = effects;
  const call =
    statement?.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression'
      ? statement.expression
      : null;
  const [callback, deps] = call?.arguments ?? [];
  if (
    effects.length !== 1 ||
    !statement ||
    callback?.type !== 'ArrowFunctionExpression' ||
    callback.params.length > 0 ||
    deps?.type !== 'ArrayExpression'
  ) {
    throw new Error(`Astryx's ${HOOK} no longer has one ${EFFECT_HOOK}(() => …, […]) to cut.`);
  }

  // The hook's own names the effect reads, passed to it where it runs now.
  const declared = new Set<string>(hook.params.flatMap(namesOf));
  for (const node of statements) {
    if (node.type === 'VariableDeclaration') {
      for (const { id } of node.declarations) for (const name of namesOf(id)) declared.add(name);
    }
  }
  const named = new Set<string>();
  walk(callback.body, (node) => {
    if (node.type === 'Identifier') named.add(node.name as string);
  });
  const passed = [...declared].filter((name) => named.has(name)).join(', ');

  const dependencies = code.slice(deps.start + 1, deps.end - 1).trim();
  const loader =
    `const [arrived$, setArrived$] = useState$(clearance$ !== undefined);\n` +
    `  ${EFFECT_HOOK}(() => {\n` +
    `    if (clearance$ !== undefined) return clearance$.clearKeyboard({ ${passed} });\n` +
    `    if (!isOpen) {\n` +
    `      preloadClearance$();\n` +
    `      return;\n` +
    `    }\n` +
    `    let isCurrent = true;\n` +
    `    void loadClearance$().then(() => {\n` +
    `      if (isCurrent && clearance$ !== undefined) setArrived$(true);\n` +
    `    });\n` +
    `    return () => {\n` +
    `      isCurrent = false;\n` +
    `    };\n` +
    `  }, [${dependencies ? `${dependencies}, ` : ''}arrived$]);`;
  const cut =
    code.slice(0, statement.start) +
    loader +
    code.slice(statement.end) +
    `\nimport { useState as useState$ } from 'react';\n` +
    `import { afterFirstScreen as afterFirstScreen$ } from ${JSON.stringify(AFTER_FIRST_SCREEN)};\n` +
    `let clearance$;\nlet loading$;\nlet preloading$;\n` +
    `function preloadClearance$() {\n` +
    `  preloading$ ??= afterFirstScreen$(() => void loadClearance$());\n` +
    `}\n` +
    `function loadClearance$() {\n` +
    `  loading$ ??= import("./${HOOK}.js${EFFECT}").then(\n` +
    `    (module) => {\n` +
    `      clearance$ = module;\n` +
    `    },\n` +
    `    () => {\n` +
    `      loading$ = undefined;\n` +
    `    },\n` +
    `  );\n` +
    `  return loading$;\n` +
    `}\n`;
  const rest = withoutUnusedImports(cut);

  const effect =
    code.slice(0, declaration.start) +
    `export function clearKeyboard({ ${passed} }) {\n` +
    `  return (${code.slice(callback.start, callback.end)})();\n` +
    `}\n` +
    code.slice(declaration.end);
  return { rest, effect };
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };

/** The names a parameter or a declaration binds. */
function namesOf(pattern: unknown): string[] {
  const node = pattern as Node | null;
  switch (node?.type) {
    case 'Identifier':
      return [node.name as string];
    case 'ArrayPattern':
      return (node.elements as unknown[]).flatMap(namesOf);
    case 'ObjectPattern':
      return (node.properties as Node[]).flatMap((property) =>
        namesOf(property.type === 'RestElement' ? property.argument : property.value),
      );
    case 'AssignmentPattern':
      return namesOf(node.left);
    case 'RestElement':
      return namesOf(node.argument);
    default:
      return [];
  }
}

/** `code` without the imports none of whose names it reads any more. */
function withoutUnusedImports(code: string): string {
  const program = parseAst(code);
  const named = new Set<string>();
  for (const node of program.body) {
    // A re-export names what it passes on, not what the module reads.
    if (
      node.type === 'ImportDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.source)
    ) {
      continue;
    }
    walk(node, (inner) => {
      if (inner.type === 'Identifier') named.add(inner.name as string);
    });
  }
  const unused = program.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.specifiers.length > 0 &&
      node.specifiers.every(({ local }) => !named.has(local.name)),
  );
  return unused.reduceRight(
    (text, { start, end }) => text.slice(0, start) + text.slice(code[end] === '\n' ? end + 1 : end),
    code,
  );
}

/** Visits `node` and every node inside it. */
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (typeof (node as Node).type === 'string') visit(node as Node);
  for (const value of Object.values(node)) walk(value, visit);
}

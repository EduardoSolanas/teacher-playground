const requireBase = new URL('../../../package.json', import.meta.url).href;
const openColorJson = new URL('../../../node_modules/open-color/open-color.json', import.meta.url).href;

function dataModule(source) {
  return 'data:text/javascript,' + encodeURIComponent(source);
}

function cjsNamedExports(specifier, names) {
  const source = [
    "import { createRequire } from 'node:module';",
    `const require = createRequire(${JSON.stringify(requireBase)});`,
    `const pkg = require(${JSON.stringify(specifier)});`,
    ...names.map((name) => `export const ${name} = pkg.${name};`),
  ].join('\n');
  return dataModule(source);
}

const OPEN_COLOR_MODULE = dataModule(
  [
    "import { readFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    `export default JSON.parse(readFileSync(fileURLToPath(${JSON.stringify(openColorJson)}), 'utf8'));`,
  ].join('\n'),
);

const SHIMMED_MODULES = {
  'open-color': OPEN_COLOR_MODULE,
  '@excalidraw/laser-pointer': cjsNamedExports('@excalidraw/laser-pointer', ['LaserPointer']),
  '@radix-ui/react-tabs': cjsNamedExports('@radix-ui/react-tabs', [
    'Root',
    'List',
    'Trigger',
    'Content',
    'Tabs',
    'TabsList',
    'TabsTrigger',
    'TabsContent',
    'createTabsScope',
  ]),
};

export async function resolve(specifier, context, nextResolve) {
  if (SHIMMED_MODULES[specifier]) {
    return { url: SHIMMED_MODULES[specifier], shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && !specifier.endsWith('.js')) {
      try {
        return await nextResolve(`${specifier}.js`, context);
      } catch {}
    }
    throw error;
  }
}

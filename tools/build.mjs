/**
 * Bundles the game into a single self-contained HTML file:
 *
 *   node tools/build.mjs   ->   dist/minimetro.html
 *
 * The module order is derived from the import graph (starting at src/main.js)
 * rather than a hand-maintained list, so adding a module can never silently
 * leave it out of the bundle. It refuses to build on an import cycle or when
 * two modules declare the same top-level name, which are the two real hazards
 * of concatenating ES modules into one scope.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/main.js';

const IMPORT_RE = /^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const BARE_IMPORT_RE = /^\s*import\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{[^}]*\}\s*;?\s*$/gm;
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

function stripModule(source) {
  return source
    .replace(IMPORT_RE, '')
    .replace(BARE_IMPORT_RE, '')
    .replace(EXPORT_LIST_RE, '')
    .replace(/^(\s*)export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '$1');
}

/** Collect every relative module this file imports. */
function dependenciesOf(source, fromRelative) {
  const deps = [];
  const fromDir = path.posix.dirname(fromRelative);
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const spec = match[1];
      if (!spec.startsWith('.')) throw new Error(`${fromRelative} imports the non-relative "${spec}"`);
      deps.push(path.posix.normalize(path.posix.join(fromDir, spec)));
    }
  }
  return deps;
}

/** Depth-first post-order walk = dependencies appear before their users. */
async function collect(relative, sources, order, visiting) {
  if (order.includes(relative)) return;
  if (visiting.has(relative)) {
    throw new Error(`Build aborted: import cycle through ${relative} (${[...visiting].join(' -> ')})`);
  }
  visiting.add(relative);
  const file = path.join(root, relative);
  const source = await readFile(file, 'utf8');
  sources.set(relative, source);
  for (const dep of dependenciesOf(source, relative)) {
    await collect(dep, sources, order, visiting);
  }
  visiting.delete(relative);
  order.push(relative);
}

async function main() {
  const sources = new Map();
  const order = [];
  await collect(ENTRY, sources, order, new Set());

  const seen = new Map();
  const chunks = [];
  for (const relative of order) {
    const raw = sources.get(relative);
    for (const match of raw.matchAll(DECL_RE)) {
      const name = match[1];
      if (seen.has(name)) {
        throw new Error(
          `Build aborted: "${name}" is declared in both ${seen.get(name)} and ${relative}. ` +
            'Rename one of them (single-file builds share one module scope).',
        );
      }
      seen.set(name, relative);
    }
    chunks.push(`// ---- ${relative} ${'-'.repeat(Math.max(0, 60 - relative.length))}\n${stripModule(raw).trim()}\n`);
  }

  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(path.join(root, 'styles.css'), 'utf8');
  const script = chunks.join('\n');

  let out = html.replace(/<link rel="stylesheet" href="\.\/styles\.css"\s*\/?>/, `<style>\n${css}\n</style>`);
  out = out.replace(/<script type="module" src="\.\/src\/main\.js"><\/script>/, `<script type="module">\n${script}\n</script>`);
  if (out === html) throw new Error('Build aborted: could not find the script/style tags to inline.');

  await mkdir(path.join(root, 'dist'), { recursive: true });
  const target = path.join(root, 'dist', 'minimetro.html');
  await writeFile(target, out, 'utf8');
  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log(`Built ${path.relative(root, target)} (${kb} kB, ${order.length} modules: ${order.join(', ')})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

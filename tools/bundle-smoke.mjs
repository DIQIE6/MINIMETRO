/**
 * Runs the single-file bundle under a minimal DOM stub so any runtime error in
 * the built artifact surfaces with a real stack trace.
 *
 *   node tools/bundle-smoke.mjs
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(root, 'dist', 'minimetro.html'), 'utf8');
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!match) throw new Error('no inline module script found in dist/minimetro.html');

const noop = () => {};
const gradient = { addColorStop: noop };

function makeContext() {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (prop === 'measureText') return () => ({ width: 0 });
        return noop;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

function makeStyle() {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'setProperty' || prop === 'removeProperty') return noop;
        if (prop === 'getPropertyValue') return () => '';
        return target[prop] ?? '';
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

function makeElement(id = '') {
  const el = {
    id,
    tagName: 'DIV',
    style: makeStyle(),
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { (on === undefined ? !this._set.has(c) : on) ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener: noop,
    removeEventListener: noop,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 760, width: 1280, height: 760 }),
    setPointerCapture: noop,
    getContext: () => makeContext(),
    focus: noop,
    click: noop,
  };
  return el;
}

const elements = new Map();
const getEl = (id) => {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
};

const listeners = new Map();
const windowStub = {
  innerWidth: 1280,
  innerHeight: 760,
  devicePixelRatio: 1,
  location: { search: '?autostart=1&demo=1&t=60' },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener: noop,
  dispatchEvent: noop,
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
  cancelAnimationFrame: noop,
  PointerEvent: class PointerEvent {},
  setTimeout,
  clearTimeout,
  performance,
  ResizeObserver: class ResizeObserver {
    observe() {}
    disconnect() {}
  },
  getComputedStyle: () => ({ display: 'block', opacity: '1' }),
};

const documentStub = {
  getElementById: getEl,
  querySelector: (sel) => getEl(sel),
  querySelectorAll: () => [],
  createElement: () => makeElement(),
  createDocumentFragment: () => makeElement('fragment'),
  addEventListener: noop,
  removeEventListener: noop,
  body: makeElement('body'),
  documentElement: makeElement('html'),
  title: '',
};

globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.performance = performance;
globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;
globalThis.ResizeObserver = windowStub.ResizeObserver;
globalThis.getComputedStyle = windowStub.getComputedStyle;

windowStub.document = documentStub;
globalThis.URLSearchParams = URLSearchParams;

// A real file rather than a data: URL, so stack traces stay readable.
const tempFile = path.join(root, '.bundle-run.mjs');
await writeFile(tempFile, match[1], 'utf8');
try {
  await import(pathToFileURL(tempFile).href);
} catch (error) {
  console.error('BUNDLE THREW:');
  console.error(error && error.stack ? error.stack : error);
  await unlink(tempFile).catch(() => {});
  process.exit(1);
}
await unlink(tempFile).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
const mm = windowStub.__minimetro;
console.log(`bundle evaluated; __minimetro = ${mm ? 'present' : 'MISSING'}`);
if (mm && mm.game) {
  console.log(`  state=${mm.game.state} stations=${mm.game.stations.length} lines=${mm.game.activeLines().length}`);
}
process.exit(mm ? 0 : 2);

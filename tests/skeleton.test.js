// Build step 1: every pure module loads under Node via require() and in a
// browser-like global via the UMD wrapper, and the vendored SheetJS is the pinned version.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '..', 'js');

// Browser load order (mirrors the <script> tags in index.html).
const MODULES = [
  ['parse.js', 'parse'],
  ['layout.js', 'layout'],
  ['correct.js', 'correct'],
  ['methods/index.js', 'methods'],
  ['methods/fici.js', 'methods/fici'],
  ['methods/bliss.js', 'methods/bliss'],
  ['methods/hsa.js', 'methods/hsa'],
  ['pool.js', 'pool'],
  ['export.js', 'export'],
];

test('each module loads with require() in Node', () => {
  for (const [file] of MODULES) {
    const mod = require(path.join(JS, file));
    assert.equal(typeof mod, 'object', file);
  }
});

test('each module attaches to window.CB when loaded as a browser script', () => {
  const win = {};
  win.window = win;
  win.globalThis = win;
  const ctx = vm.createContext(win);
  for (const [file] of MODULES) {
    vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), ctx, { filename: file });
  }
  for (const [file, name] of MODULES) {
    assert.equal(typeof win.CB[name], 'object', `${file} -> CB['${name}']`);
  }
});

test('pure modules do not reference the DOM', () => {
  for (const [file, name] of MODULES) {
    if (name === 'export') continue; // download helpers may touch the DOM
    const src = fs.readFileSync(path.join(JS, file), 'utf8');
    assert.doesNotMatch(src, /\b(document|window)\s*\./, file);
  }
});

test('vendored SheetJS loads in Node and is pinned to 0.20.3', () => {
  const XLSX = require(path.join(JS, 'vendor', 'xlsx.full.min.js'));
  assert.equal(XLSX.version, '0.20.3');
  assert.equal(typeof XLSX.read, 'function');
});

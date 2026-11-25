// Build step 10: export.js (SPEC section 12): CSVs, standalone SVG, session JSON.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/layout.js');
const F = require('../js/methods/fici.js');
const Bliss = require('../js/methods/bliss.js');
const HSA = require('../js/methods/hsa.js');
const Pool = require('../js/pool.js');
const X = require('../js/export.js');
const H = require('./helpers.js');

const SETTINGS = { cutoff: 0.95, useT0: true, useDrift: true, reference: 'drugfree' };

// minimal CSV reader for the tests (handles quoted cells)
function parseCSV(text) {
  return text.trim().split('\n').map((line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

function caseResults(c) {
  const ctx = { frac: c.corr.frac, A: c.layout.A, B: c.layout.B, settings: SETTINGS };
  return { fici: F.run(ctx), bliss: Bliss.run(ctx), hsa: HSA.run(ctx) };
}

test('standalone SVG: white background, caption, embedded style, focus ring removed', () => {
  const svg = '<svg width="100" height="50" class="heatmap"><rect class="cell" x="0" y="0" width="10" height="10"></rect>' +
    '<rect class="focus-ring" width="54" height="54" x="-999" y="-999"></rect><text>42</text></svg>';
  const out = X.standaloneSVG(svg, 100, 50, '.cell{stroke:#000}', 'Plate <1> & co');
  assert.match(out, /^<\?xml/);
  assert.match(out, /width="100" height="74"/);
  assert.match(out, /<style>\.cell\{stroke:#000\}<\/style>/);
  assert.match(out, /fill="#ffffff"/);
  assert.match(out, /Plate &lt;1&gt; &amp; co/);
  assert.doesNotMatch(out, /focus-ring/);
  assert.match(out, /<g transform="translate\(0,24\)"><rect class="cell"/);
});

test('safeName makes file-name-safe labels', () => {
  assert.equal(X.safeName('1109 CF+CLZ (copy)'), '1109_CF+CLZ_copy');
  assert.equal(X.safeName('  '), 'plate');
});

// ---------------------------------------------------------------- session JSON
function sampleState() {
  const reads = [
    ...H.loadReads('cf&clz or pcc 20261109 to 1111/cfclz/cfclz initial.xlsx'),
    ...H.loadReads('cf&clz or pcc 20261109 to 1111/cfclz/cfclz 47hr.xlsx'),
  ];
  reads[1].grid = reads[1].grid.map((row) => row.slice());
  reads[1].grid[7][11] = NaN; // a non-numeric well survives the round trip
  const custom = L.clone(L.getPreset('p1104-8x8'));
  custom.id = 'custom-abc'; custom.name = 'My 8x8'; delete custom.preset;
  return {
    settings: { cutoff: 0.9, useT0: true, useDrift: false, reference: 'solventfreeMean' },
    enabled: { fici: true, bliss: false, hsa: true },
    layouts: [custom],
    plates: [
      { id: 'p1', name: 'A', pair: L.clone(L.getPreset('p1109-10x8-clz')).pair, layoutId: 'p1109-10x8-clz', group: 'g1', reads, t0Index: 0, analysisReadIndex: 1 },
      { id: 'p2', name: 'B', pair: null, layoutId: 'custom-abc', group: '', reads: [], t0Index: 0, analysisReadIndex: 0 },
    ],
  };
}
const known = (id) => !!L.getPreset(id);

test('session: export -> JSON text -> import rebuilds the same plates, reads and settings', { skip: H.fixturesSkip }, () => {
  const st = sampleState();
  const json = X.sessionToJSON(st, new Date('2026-11-24T12:00:00Z'));
  assert.equal(json.schema, 'checkerboard-session/1');
  assert.equal(json.exported, '2026-11-24T12:00:00.000Z');
  assert.equal(json.plates[0].reads[1].grid[7][11], null);
  const back = X.sessionFromJSON(JSON.parse(JSON.stringify(json)), known);
  assert.deepEqual(back.settings, st.settings);
  assert.deepEqual(back.enabled, st.enabled);
  assert.equal(back.layouts[0].id, 'custom-abc');
  assert.deepEqual(L.validate(back.layouts[0], { useDrift: true }), []);
  assert.equal(back.plates.length, 2);
  const [a, b] = back.plates;
  assert.deepEqual([a.name, a.group, a.layoutId, a.t0Index, a.analysisReadIndex], ['A', 'g1', 'p1109-10x8-clz', 0, 1]);
  assert.equal(a.reads.length, 2);
  a.reads.forEach((r, i) => {
    assert.equal(r.start.getTime(), st.plates[0].reads[i].start.getTime());
    assert.equal(r.source, st.plates[0].reads[i].source);
    assert.equal(r.lid, st.plates[0].reads[i].lid);
  });
  assert.ok(Number.isNaN(a.reads[1].grid[7][11]));
  assert.deepEqual(a.reads[0].grid, st.plates[0].reads[0].grid);
  assert.equal(b.pair, null);
  assert.equal(b.layoutId, 'custom-abc');
});

test('session import rejects a wrong schema, bad grids, bad times and unknown layouts', () => {
  const ok = { schema: 'checkerboard-session/1', settings: {}, layouts: [],
    plates: [{ id: 'p', name: 'P', layoutId: 'p1104-8x8', reads: [{ start: '2026-01-01T00:00:00Z', source: 'single', file: 'f', grid: Array.from({ length: 8 }, () => Array(12).fill(0.1)) }] }] };
  assert.equal(X.sessionFromJSON(ok, known).plates[0].reads.length, 1);
  const bad = (mut) => { const o = JSON.parse(JSON.stringify(ok)); mut(o); return () => X.sessionFromJSON(o, known); };
  assert.throws(bad((o) => { o.schema = 'other/2'; }), /Unknown schema/);
  assert.throws(bad((o) => { o.plates[0].reads[0].grid.pop(); }), /8 rows of 12/);
  assert.throws(bad((o) => { o.plates[0].reads[0].grid[3][4] = 'x'; }), /8 rows of 12/);
  assert.throws(bad((o) => { o.plates[0].reads[0].start = 'yesterday'; }), /bad start time/);
  assert.throws(bad((o) => { o.plates[0].reads[0].source = 'magic'; }), /unknown source/);
  assert.throws(bad((o) => { o.plates[0].layoutId = 'nope'; }), /neither a preset nor in the file/);
  assert.throws(bad((o) => { o.layouts = [{ id: 'z', A: [0, 1], B: [0, 1], roles: {} }]; }), /drug-free/);
  assert.throws(() => X.sessionFromJSON(null, known), /Not a session/);
});

test('session import clamps out-of-range settings and indices', () => {
  const o = { schema: 'checkerboard-session/1', settings: { cutoff: 5, reference: 'weird' }, layouts: [],
    plates: [{ id: 'p', name: 'P', layoutId: 'p1104-8x8', t0Index: 9, analysisReadIndex: -1,
      reads: [{ start: '2026-01-02T00:00:00Z', source: 'single', file: 'b', grid: Array.from({ length: 8 }, () => Array(12).fill(0.2)) },
        { start: '2026-01-01T00:00:00Z', source: 'single', file: 'a', grid: Array.from({ length: 8 }, () => Array(12).fill(0.1)) }] }] };
  const s = X.sessionFromJSON(o, known);
  assert.equal(s.settings.cutoff, 0.95);
  assert.equal(s.settings.reference, 'drugfree');
  assert.deepEqual(s.plates[0].reads.map((r) => r.file), ['a', 'b']); // sorted by time
  assert.deepEqual([s.plates[0].t0Index, s.plates[0].analysisReadIndex], [0, 1]);
});

test('standalone SVG: multi-line captions add 18 px per extra line', () => {
  const out = X.standaloneSVG('<svg width="10" height="10"></svg>', 10, 10, '', ['Line one', 'Line two']);
  assert.equal(X.captionHeight(['a', 'b']), 42);
  assert.equal(X.captionHeight('a'), 24);
  assert.equal(X.captionHeight(null), 0);
  assert.match(out, /height="52"/);
  assert.match(out, /<text x="8" y="35" class="caption caption-sub">Line two<\/text>/);
});

// Build step 8: pool.js and the methods' pool() (SPEC section 10).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/layout.js');
const registry = require('../js/methods/index.js');
const F = require('../js/methods/fici.js');
const Bliss = require('../js/methods/bliss.js');
require('../js/methods/hsa.js');
const Pool = require('../js/pool.js');
const H = require('./helpers.js');

const getLayout = (p) => L.getPreset(p.layoutId);
const pairOf = (id) => JSON.parse(JSON.stringify(L.getPreset(id).pair));

test('grouping: same drug pair and concentration lists group; different ones do not', () => {
  const plates = [
    { id: 'a', layoutId: 'p1109-10x8-clz', pair: pairOf('p1109-10x8-clz') },
    { id: 'b', layoutId: 'p1104-8x8', pair: pairOf('p1104-8x8') },          // same pair, different concentrations
    { id: 'c', layoutId: 'p1109-10x8-clz', pair: pairOf('p1109-10x8-clz') },
    { id: 'd', layoutId: 'p1109-10x8-pcc', pair: pairOf('p1109-10x8-pcc') },
  ];
  const groups = Pool.groupPlates(plates, getLayout);
  assert.deepEqual(groups.map((g) => g.plateIds), [['a', 'c'], ['b'], ['d']]);
  assert.ok(groups.every((g) => g.sameConcs && !g.custom));
  assert.match(groups[0].label, /^CF \+ CLZ · 10×8/);
});

test('grouping: drug names match case-insensitively; a different name splits the group', () => {
  const p = pairOf('p1104-8x8');
  const q = pairOf('p1104-8x8'); q.B.name = ' clz ';
  const r = pairOf('p1104-8x8'); r.B.name = 'CLZ-2';
  const groups = Pool.groupPlates([
    { id: 'a', layoutId: 'p1104-8x8', pair: p },
    { id: 'b', layoutId: 'p1104-8x8', pair: q },
    { id: 'c', layoutId: 'p1104-8x8', pair: r },
  ], getLayout);
  assert.deepEqual(groups.map((g) => g.plateIds), [['a', 'b'], ['c']]);
});

test('grouping: the user override puts plates together and records whether concentrations match', () => {
  const groups = Pool.groupPlates([
    { id: 'a', layoutId: 'p1109-10x8-clz', pair: pairOf('p1109-10x8-clz'), group: 'CF+CLZ all' },
    { id: 'b', layoutId: 'p1104-8x8', pair: pairOf('p1104-8x8'), group: 'CF+CLZ all' },
    { id: 'c', layoutId: 'p1104-8x8', pair: pairOf('p1104-8x8'), group: '  ' }, // blank = automatic
  ], getLayout);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { key: 'custom:CF+CLZ all', label: 'CF+CLZ all', custom: true, plateIds: ['a', 'b'], sameConcs: false });
  assert.deepEqual(groups[1].plateIds, ['c']);
});

// ---------------------------------------------------------------- FICI pooling
const fr = (fici, bound) => ({ ficiMin: { fici, bound: !!bound }, class: F.oddsClass(fici), cutoff: 0.95 });

test('FICI pool: median FICImin, range, n, consistency count, class from the median', () => {
  const p = F.pool([fr(0.375), fr(0.625), fr(0.5)]);
  assert.equal(p.n, 3);
  assert.equal(p.medianFiciMin, 0.5);
  assert.deepEqual([p.min, p.max], [0.375, 0.625]);
  assert.equal(p.class, 'synergy');
  assert.equal(p.consistency, 'synergy on 2 of 3 plates');
  assert.equal(p.anyBound, false);
});

test('FICI pool: even n uses the mean of the middle two; bounds are flagged; no-boundary plates count in n', () => {
  const p = F.pool([fr(0.375), fr(1.25, true), { ficiMin: null, class: null, cutoff: 0.95 }, fr(0.75)]);
  assert.equal(p.n, 4);
  assert.equal(p.nWithFici, 3);
  assert.equal(p.medianFiciMin, 0.75);
  assert.equal(p.class, 'indifference');
  assert.equal(p.consistency, 'indifference on 2 of 4 plates');
  assert.equal(p.anyBound, true);
  assert.equal(p.classCounts.none, 1);
});

// ---------------------------------------------------------------- Bliss/HSA pooling
const br = (meanPP, max3x3PP, excess) => ({ meanPP, max3x3PP, excess });

test('Bliss pool: mean ± SD of per-plate scores; heatmaps averaged only when concentrations match', () => {
  const rs = [br(10, 50, [[0.1, 0.2]]), br(20, 60, [[0.3, 0.4]]), br(30, 70, [[0.5, 0.0]])];
  const p = Bliss.pool(rs, { sameConcs: true });
  assert.equal(p.n, 3);
  assert.equal(p.meanPP.mean, 20);
  H.assertClose(assert, p.meanPP.sd, 10, 1e-12, 'sd');
  assert.equal(p.max3x3PP.mean, 60);
  H.assertMatrixClose(assert, p.avgExcess, [[0.3, 0.2]], 1e-12, 'avg');

  const q = Bliss.pool(rs, { sameConcs: false });
  assert.equal(q.avgExcess, null);
  assert.match(q.avgReason, /Concentrations differ/);

  const one = Bliss.pool([rs[0]], { sameConcs: true });
  assert.equal(one.meanPP.sd, null);
});

// ---------------------------------------------------------------- whole-group pooling
test('poolGroup runs every registered pool(); n < 3 gives the fewer-than-3 message', () => {
  const entries = [
    { plateId: 'a', results: { fici: fr(0.375), bliss: br(10, 50, [[0.1]]), hsa: br(12, 55, [[0.1]]) } },
    { plateId: 'b', results: { fici: fr(0.625), bliss: br(20, 60, [[0.3]]), hsa: br(22, 65, [[0.3]]) } },
  ];
  const g = Pool.poolGroup(entries, { sameConcs: true });
  assert.equal(g.n, 2);
  assert.equal(g.fewerThan3, true);
  assert.equal(g.message, 'Fewer than 3 independent repeats.');
  assert.deepEqual(Object.keys(g.methods).sort(), ['bliss', 'fici', 'hsa']);
  assert.equal(g.methods.fici.medianFiciMin, 0.5);
  assert.equal(g.methods.fici.class, 'synergy'); // median 0.5 ≤ 0.5
  assert.equal(g.methods.hsa.meanPP.mean, 17);

  const csv = Pool.pooledCSV(g);
  assert.equal(csv.split('\n')[0], registry.CSV_HEADER);
  assert.match(csv, /^fici,pooled_median_FICImin,0\.5,,n=2$/m);
  assert.match(csv, /^bliss,pooled_mean_excess_pp_mean,15,,n=2$/m);

  assert.equal(Pool.poolGroup([...entries, entries[0]], { sameConcs: true }).message, null);
});

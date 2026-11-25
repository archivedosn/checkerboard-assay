// Build step 5: methods/bliss.js and methods/hsa.js. SPEC section 9 Bliss/HSA acceptance tests.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../js/methods/index.js');
const Bliss = require('../js/methods/bliss.js');
const HSA = require('../js/methods/hsa.js');
const H = require('./helpers.js');

const SETTINGS = { cutoff: 0.95, useT0: true, useDrift: true, reference: 'drugfree' };

test('excess heatmaps and summaries match reference_analysis.py well by well', { skip: H.oracleSkip }, () => {
  for (const c of H.oracleCases(SETTINGS)) {
    for (const [mod, key] of [[Bliss, 'bliss'], [HSA, 'hsa']]) {
      const res = mod.run({ frac: c.corr.frac, A: c.layout.A, B: c.layout.B, settings: {} });
      const want = c.oc.bliss[key];
      H.assertMatrixClose(assert, res.excess, want.excess, 1e-12, `${c.oc.name} ${key} excess`);
      H.assertClose(assert, res.mean, want.mean, 1e-12, `${c.oc.name} ${key} mean`);
      H.assertClose(assert, res.max3x3, want.max3x3, 1e-12, `${c.oc.name} ${key} max3x3`);
      assert.deepEqual([res.excess.length, res.excess[0].length], [c.layout.nRows - 1, c.layout.nCols - 1]);
    }
  }
});

test('formulas on a hand-worked 3×3 matrix', () => {
  // g: drug-free 1; A alone 0.6 (E_A 0.4); B alone 0.5 (E_B 0.5); combination 0.1 (E 0.9)
  const frac = [[1, 0.6, 0.6], [0.5, 0.1, 0.1], [0.5, 0.1, 0.1]];
  const b = Bliss.run({ frac });
  const h = HSA.run({ frac });
  // Bliss: E_exp = 0.4 + 0.5 − 0.2 = 0.7 -> excess 0.2; HSA: E_exp = 0.5 -> excess 0.4
  b.excess.flat().forEach((x) => H.assertClose(assert, x, 0.2, 1e-12, 'bliss'));
  h.excess.flat().forEach((x) => H.assertClose(assert, x, 0.4, 1e-12, 'hsa'));
  // only a 2×2 block of combination wells: no 3×3 window
  assert.equal(b.max3x3, null);
  assert.equal(b.max3x3At, null);
});

test('g is clipped to [0, 1] before computing E (negative and >1 growth)', () => {
  const frac = [[1, 1.3, 0.5], [-0.2, 0.0, 0.5], [0.5, 0.5, 0.5]];
  const res = Bliss.run({ frac });
  // well [1][1]: E = 1; E_A = 1 − clip(1.3) = 0; E_B = 1 − clip(−0.2) = 1 -> E_exp = 1 -> excess 0
  H.assertClose(assert, res.excess[0][0], 0, 1e-12, 'clipped');
});

test('max 3×3 is the best window mean and reports its position', () => {
  // 5×5 matrix -> 4×4 combination wells. Strong excess only in the bottom-right 3×3 block.
  const frac = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) =>
    (r === 0 || c === 0) ? 1 : (r >= 2 && c >= 2 ? 0 : 1)));
  const res = Bliss.run({ frac });
  H.assertClose(assert, res.max3x3, 1, 1e-12, 'max3x3');
  assert.deepEqual(res.max3x3At, { r: 2, c: 2 });
  H.assertClose(assert, res.mean, 9 / 16, 1e-12, 'mean');
});

test('registry: both register; notes say there is no threshold; CSV rows', () => {
  assert.equal(registry.get('bliss'), Bliss);
  assert.equal(registry.get('hsa'), HSA);
  assert.equal(Bliss.NOTE, 'Bliss has no agreed cut-off; FICI and Bliss can disagree on the same data.');
  // 4×4 matrix -> 3×3 combination wells; HSA excess 0.4 everywhere (see the hand-worked case above)
  const frac = Array.from({ length: 4 }, (_, r) => Array.from({ length: 4 }, (_, c) =>
    (r === 0 && c === 0) ? 1 : r === 0 ? 0.6 : c === 0 ? 0.5 : 0.1));
  const csv = HSA.toCSV(HSA.run({ frac }));
  assert.match(csv, /^hsa,mean_excess_pp,40,,$/m);
  assert.equal(csv.split('\n').filter((l) => l.includes('excess_pp_r')).length, 3 * 3);
});

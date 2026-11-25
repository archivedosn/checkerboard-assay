// Build step 4: methods/fici.js. SPEC section 9 FICI acceptance tests, plus agreement with reference_analysis.py.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/parse.js');
const L = require('../js/layout.js');
const C = require('../js/correct.js');
const registry = require('../js/methods/index.js');
const F = require('../js/methods/fici.js');
const H = require('./helpers.js');

const TOL = 0.001; // SPEC 9: ±0.001 on FICI
const SETTINGS = { cutoff: 0.95, useT0: true, useDrift: true, reference: 'drugfree' };

function runCase({ corr, layout }, extra) {
  return F.run(Object.assign({ frac: corr.frac, A: layout.A, B: layout.B, settings: { cutoff: 0.95 } }, extra));
}
const byName = (name) => H.oracleCases(SETTINGS).find((x) => x.oc.name === name);

// ---------------------------------------------------------------- SPEC section 9 table
// ---------------------------------------------------------------- agreement with the oracle at every cut-off
test('MICs, boundary wells, FICImin/max, floor and near wells match reference_analysis.py at 50/80/90/95%', { skip: H.oracleSkip }, () => {
  for (const c of H.oracleCases(SETTINGS)) {
    for (const [k, want] of Object.entries(c.oc.fici)) {
      const an = F.analyse(c.corr.frac, c.layout.A, c.layout.B, Number(k));
      const tag = `${c.oc.name} @${k}`;
      assert.equal(an.micA.mic, want.micA, `${tag} micA`);
      assert.equal(an.micA.bound, want.offA, `${tag} offA`);
      assert.equal(an.micB.mic, want.micB, `${tag} micB`);
      assert.equal(an.micB.bound, want.offB, `${tag} offB`);
      assert.deepEqual(an.boundary.map((w) => [w.fici, w.a, w.b]), want.boundary, `${tag} boundary`);
      if (want.ficiMin) {
        assert.deepEqual([an.ficiMin.fici, an.ficiMin.a, an.ficiMin.b], want.ficiMin, `${tag} ficiMin`);
        assert.deepEqual([an.ficiMax.fici, an.ficiMax.a, an.ficiMax.b], want.ficiMax, `${tag} ficiMax`);
      } else {
        assert.equal(an.ficiMin, null, `${tag} no boundary`);
      }
      H.assertClose(assert, an.floor, want.floor, 1e-12, `${tag} floor`);
      assert.deepEqual(an.near.map((x) => [x.r, x.c]), want.near.map((x) => [x[0], x[1]]), `${tag} near`);
    }
  }
});

// ---------------------------------------------------------------- robustness panel
test('robustness: cut-off table has 50/80/90/95 plus the slider value', { skip: H.oracleSkip }, () => {
  const c = byName('1109 CF+CLZ');
  const res = F.run({ frac: c.corr.frac, A: c.layout.A, B: c.layout.B, settings: { cutoff: 0.85 } });
  assert.deepEqual(res.robustness.cutoffTable.map((t) => t.cutoff), [0.5, 0.8, 0.85, 0.9, 0.95]);
  assert.deepEqual(res.robustness.cutoffTable.filter((t) => t.current).map((t) => t.cutoff), [0.85]);
  assert.equal(res.robustness.banner, F.N1_BANNER);
  assert.match(res.oddsNote, /FICI ≈ 1/);
});

test('robustness: attainable floor above 0.5 gives the cannot-detect-synergy message', () => {
  // 3x3, A = [0,1,2], B = [0,1,2]: everything inhibited except drug-free -> MICs 1 and 1, floor 2.
  const frac = [[1, 0, 0], [0, 0, 0], [0, 0, 0]];
  const res = F.run({ frac, A: [0, 1, 2], B: [0, 1, 2], settings: { cutoff: 0.95 } });
  assert.equal(res.robustness.floor, 2);
  assert.equal(res.robustness.floorWarning, F.FLOOR_MSG);
});

// ---------------------------------------------------------------- unit rules
test('MIC rule: lowest non-zero conc from which every higher conc is inhibited; else 2 × top (bound)', () => {
  assert.deepEqual(F.mic([false, false, true, true], [0, 1, 2, 4]), { mic: 2, index: 2, bound: false });
  // a skipped well (growth at the top) prevents an MIC below it
  assert.deepEqual(F.mic([false, true, false, true], [0, 1, 2, 4]), { mic: 4, index: 3, bound: false });
  assert.deepEqual(F.mic([false, true, true, false], [0, 1, 2, 4]), { mic: 8, index: null, bound: true });
});

test('Odds (2003) classes and boundaries', () => {
  assert.equal(F.oddsClass(0.5), 'synergy');
  assert.equal(F.oddsClass(0.5000001), 'indifference');
  assert.equal(F.oddsClass(4), 'indifference');
  assert.equal(F.oddsClass(4.0001), 'antagonism');
});

test('inhibited means g ≤ 1 − cutoff; near band is ±0.02 around it', () => {
  // (values exactly 0.02 from the cut-off are avoided: in floating point they fall either side, as in the oracle)
  const frac = [[1, 0.05, 0.0], [0.065, 0.035, 0.0], [0.0, 0.0, 0.075]];
  const an = F.analyse(frac, [0, 1, 2], [0, 1, 2], 0.95);
  assert.equal(an.inhibited[0][1], true);       // 0.05 ≤ 0.05
  assert.equal(an.inhibited[1][0], false);      // 0.065
  assert.deepEqual(an.near.map((n) => [n.r, n.c]), [[0, 1], [1, 0], [1, 1]]);
});

test('registry: fici registers itself and exports CSV with bound flags', () => {
  assert.equal(registry.get('fici'), F);
  assert.deepEqual(F.requires, ['endpoint']);
  assert.deepEqual(F.defaults, { cutoff: 0.95 });
  // B never inhibits on its own -> MIC_B off-scale (2 × top = 4, bound)
  const frac = [[1, 0, 0], [1, 0, 0], [1, 0, 0]];
  const csv = F.toCSV(F.run({ frac, A: [0, 1, 2], B: [0, 1, 2], settings: { cutoff: 0.95 } }));
  assert.match(csv, /^fici,MIC_B,4,bound,cutoff=0\.95$/m);
  assert.match(csv, /^fici,class,/m);
});


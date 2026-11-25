// Build step 3: correct.js (SPEC section 7), checked against reference_analysis.py.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/layout.js');
const C = require('../js/correct.js');
const H = require('./helpers.js');

const codes = (corr) => corr.warnings.map((w) => w.code);

// ---------------------------------------------------------------- agreement with the oracle
test('growth fractions and drift match reference_analysis.py on the section 9 cases', { skip: H.oracleSkip }, () => {
  const cases = H.oracleCases();
  assert.equal(cases.length, 3);
  for (const { oc, corr } of cases) {
    H.assertMatrixClose(assert, corr.frac, oc.frac, 1e-12, `${oc.name} frac`);
    oc.driftPct.forEach((d, r) => H.assertClose(assert, corr.driftPctOfRef[r], d, 1e-9, `${oc.name} drift row ${r}`));
    assert.equal(corr.frac[0][0], 1);
  }
});

test('colour stability is reported (informational) for inhibited top-concentration wells', { skip: H.oracleSkip }, () => {
  const { corr, layout } = H.oracleCases()[0];
  const w = corr.warnings.find((x) => x.code === 'colour-stability');
  assert.ok(w && w.info);
  for (const cw of w.wells) {
    assert.ok(cw.r === layout.nRows - 1 || cw.c === layout.nCols - 1);
    assert.ok(corr.frac[cw.r][cw.c] <= 0.05);
    H.assertClose(assert, cw.relChange, (cw.odx - cw.od0) / cw.od0, 1e-15, cw.well);
  }
});

// ---------------------------------------------------------------- synthetic plates
// OD_0 = 0.1 everywhere; growth added on top. Default layout: 1104 preset (cell-free col 9, solvent-free col 10).
const L1104 = L.getPreset('p1104-8x8');
function plate(f) {
  const t0 = Array.from({ length: 8 }, () => Array(12).fill(0.1));
  const tx = t0.map((row, r) => row.map((v, c) => v + f(r, c)));
  return { t0, tx };
}

test('formula: dOD, per-row drift, dOD_corr, ref and g', () => {
  // drift 0.01 * (row+1) in every well of the row; drug-free growth 1.0; well B3 grows 0.5.
  const { t0, tx } = plate((r, c) => {
    const drift = 0.01 * (r + 1);
    if (c === 8) return drift;                    // cell-free column 9
    if (r === 0 && c === 0) return 1 + drift;     // A1 drug-free
    if (r === 1 && c === 2) return 0.5 + drift;   // B3
    if (c === 9) return 1 + drift;                // solvent-free
    return drift;
  });
  const k = C.correct({ t0, tx, layout: L1104 });
  assert.equal(k.ref, k.refDrugfree);
  H.assertClose(assert, k.ref, 1, 1e-12, 'ref');
  H.assertClose(assert, k.drift[3], 0.04, 1e-12, 'drift row D');
  H.assertClose(assert, k.frac[1][2], 0.5, 1e-12, 'g(B3)');
  H.assertClose(assert, k.frac[5][5], 0, 1e-12, 'g(F6)');
  H.assertClose(assert, k.dOD[1][2], 0.52, 1e-12, 'dOD(B3)'); // 0.5 growth + row B drift 0.02
  H.assertClose(assert, k.dODcorr[1][2], 0.5, 1e-12, 'dOD_corr(B3)');
  assert.deepEqual([k.frac.length, k.frac[0].length], [8, 8]);
  assert.ok(codes(k).includes('drift-high')); // rows up to 8%
  assert.ok(!codes(k).includes('ref-mismatch'));
});

test('negative values are kept, not clipped', () => {
  const { t0, tx } = plate((r, c) => (r === 0 && c === 0 ? 1 : c === 3 ? -0.02 : 0));
  const k = C.correct({ t0, tx, layout: L1104, settings: { useDrift: false } });
  H.assertClose(assert, k.frac[2][3], -0.02, 1e-12, 'negative g');
});

test('toggles: useT0 off uses raw OD; useDrift off leaves drift null', () => {
  const { t0, tx } = plate((r, c) => (r === 0 && c === 0 ? 1 : 0.05));
  const raw = C.correct({ t0, tx, layout: L1104, settings: { useT0: false, useDrift: false } });
  H.assertClose(assert, raw.dOD[0][0], 1.1, 1e-12, 'raw OD');
  assert.ok(raw.drift.every((d) => d === null));
  assert.throws(() => C.correct({ t0: null, tx, layout: L1104 }), /no t0 read/);
  const noT0 = C.correct({ t0: null, tx, layout: L1104, settings: { useT0: false } });
  assert.ok(!codes(noT0).includes('colour-stability'));
});

test('warning: drift on but the layout has no cell-free wells -> step skipped', () => {
  const l = L.clone(L1104);
  for (let r = 0; r < 8; r++) delete l.roles['ABCDEFGH'[r] + '9'];
  l.cellfreeByRow = {};
  const { t0, tx } = plate((r, c) => (r === 0 && c === 0 ? 1 : 0.03));
  const k = C.correct({ t0, tx, layout: l });
  assert.ok(codes(k).includes('no-cellfree'));
  assert.ok(k.drift.every((d) => d === null));
  H.assertClose(assert, k.frac[3][3], 0.03, 1e-12, 'uncorrected');
});

test('reference: solvent-free mean option, and the >15% mismatch warning', () => {
  // drug-free 1.0; solvent-free wells (col 10) grow 1.2 -> 20% difference.
  const { t0, tx } = plate((r, c) => (r === 0 && c === 0 ? 1 : c === 9 ? 1.2 : 0));
  const k = C.correct({ t0, tx, layout: L1104, settings: { useDrift: false, reference: 'solventfreeMean' } });
  H.assertClose(assert, k.ref, 1.2, 1e-12, 'ref = solvent-free mean');
  H.assertClose(assert, k.frac[0][0], 1 / 1.2, 1e-12, 'g(A1)');
  const w = k.warnings.find((x) => x.code === 'ref-mismatch');
  assert.ok(w);
  H.assertClose(assert, w.relDiff, 0.2, 1e-12, 'relDiff');

  const ok = plate((r, c) => (r === 0 && c === 0 ? 1 : c === 9 ? 1.1 : 0));
  const k2 = C.correct({ t0: ok.t0, tx: ok.tx, layout: L1104, settings: { useDrift: false } });
  assert.ok(!codes(k2).includes('ref-mismatch'), '10% is within tolerance');
});

test('non-positive reference is flagged as an error', () => {
  const { t0, tx } = plate(() => 0);
  const k = C.correct({ t0, tx, layout: L1104, settings: { useDrift: false } });
  const w = k.warnings.find((x) => x.code === 'ref-nonpositive');
  assert.equal(w.severity, 'error');
});

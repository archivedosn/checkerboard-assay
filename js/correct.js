/* correct.js: Background correction + growth fraction (SPEC section 7).
 * Pure: no DOM access.
 *
 *   dOD(well)      = OD_x(well) − OD_0(well)            [if useT0]
 *   drift(row)     = dOD(cell-free well of that row)
 *   dOD_corr(well) = dOD(well) − drift(row)             [if useDrift]
 *   ref            = dOD_corr(drug-free well)           [or mean over solvent-free wells]
 *   g(well)        = dOD_corr(well) / ref
 *
 * Negative values are kept; clip only for display. */
(function (name, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    // Node: dependencies come from require()
    module.exports = factory(function (key, nodePath) { return require(nodePath); });
  } else {
    // Browser <script>: dependencies come from the global CB (load order matters)
    var CB = (globalThis.CB = globalThis.CB || {});
    CB[name] = factory(function (key) {
      if (!(key in CB)) throw new Error('CB.' + name + ' needs CB.' + key + '; load it first');
      return CB[key];
    });
  }
})('correct', function (need) {
  'use strict';

  var L = need('layout', './layout.js');
  var NR = L.PLATE_ROWS, NC = L.PLATE_COLS;

  var DEFAULT_SETTINGS = Object.freeze({ cutoff: 0.95, useT0: true, useDrift: true, reference: 'drugfree' });

  // Warning thresholds (SPEC section 7).
  var REF_MISMATCH = 0.15;   // drug-free vs solvent-free mean, relative to the drug-free value
  var DRIFT_LIMIT = 0.02;    // |cell-free drift| as a fraction of ref
  var COLOUR_G_MAX = 0.05;   // colour-stability check covers inhibited wells with g ≤ this

  function grid(f) {
    var out = [];
    for (var r = 0; r < NR; r++) {
      var row = [];
      for (var c = 0; c < NC; c++) row.push(f(r, c));
      out.push(row);
    }
    return out;
  }

  function at(g, id) {
    var p = L.parseWellId(id);
    return g[p.row][p.col];
  }

  function mean(xs) {
    return xs.reduce(function (s, x) { return s + x; }, 0) / xs.length;
  }

  function pct(x) { return (x * 100).toFixed(1) + '%'; }

  /**
   * opts = { t0: number[8][12] | null, tx: number[8][12], layout, settings }
   * Returns {
   *   settings, odT0, odTx, dOD, drift: (number|null)[8], dODcorr, ref, refDrugfree, solventfreeMean,
   *   growth: number[8][12] (every well, dOD_corr / ref), frac: number[nRows][nCols] (matrix only),
   *   driftPctOfRef: (number|null)[8], warnings: [{ code, message, ... }] }
   */
  function correct(opts) {
    var layout = opts.layout;
    var s = Object.assign({}, DEFAULT_SETTINGS, opts.settings || {});
    var tx = opts.tx, t0 = opts.t0 || null;
    var warnings = [];

    if (s.useT0 && !t0) throw new Error('Initial-read subtraction is on but there is no t0 read.');

    // 1. initial-read subtraction
    var dOD = grid(function (r, c) { return s.useT0 ? tx[r][c] - t0[r][c] : tx[r][c]; });

    // 2. per-row cell-free drift
    var drift = [];
    for (var r = 0; r < NR; r++) drift.push(null);
    var cellfree = L.wellsWithRole(layout, 'cellfree');
    if (s.useDrift) {
      if (!cellfree.length) {
        warnings.push({ code: 'no-cellfree',
          message: 'Drift correction is on but the layout has no cell-free wells, so that step was skipped.' });
      } else {
        var missing = [];
        for (var pr = 0; pr < NR; pr++) {
          var id = L.cellfreeForRow(layout, pr);
          if (id) drift[pr] = at(dOD, id);
          else if (L.matrixIndex(layout, pr, layout.matrixOrigin.col)) missing.push('ABCDEFGH'[pr]);
        }
        if (missing.length) {
          warnings.push({ code: 'cellfree-missing-rows', rows: missing,
            message: 'No cell-free well in matrix row(s) ' + missing.join(', ') + '; those rows were not drift-corrected.' });
        }
      }
    }
    var dODcorr = grid(function (r, c) { return drift[r] === null ? dOD[r][c] : dOD[r][c] - drift[r]; });

    // 3. reference growth
    var dfId = L.wellsWithRole(layout, 'drugfree')[0];
    if (!dfId) throw new Error('The layout has no drug-free well.');
    var refDrugfree = at(dODcorr, dfId);
    var sfIds = L.wellsWithRole(layout, 'solventfree');
    var solventfreeMean = sfIds.length ? mean(sfIds.map(function (id) { return at(dODcorr, id); })) : null;

    var ref = refDrugfree;
    if (s.reference === 'solventfreeMean') {
      if (solventfreeMean === null) {
        warnings.push({ code: 'no-solventfree',
          message: 'Reference is the solvent-free mean but the layout has no solvent-free wells; using the drug-free well.' });
      } else {
        ref = solventfreeMean;
      }
    }
    if (!(ref > 0)) {
      warnings.push({ code: 'ref-nonpositive', severity: 'error', ref: ref,
        message: 'Reference growth (' + ref.toFixed(4) + ') is not positive; growth fractions are meaningless.' });
    }

    if (solventfreeMean !== null && refDrugfree > 0) {
      var diff = Math.abs(solventfreeMean - refDrugfree) / refDrugfree;
      if (diff > REF_MISMATCH) {
        warnings.push({ code: 'ref-mismatch', drugfree: refDrugfree, solventfreeMean: solventfreeMean, relDiff: diff,
          message: 'Drug-free well (' + refDrugfree.toFixed(4) + ') and solvent-free mean (' +
            solventfreeMean.toFixed(4) + ') differ by ' + pct(diff) + ' (more than 15%).' });
      }
    }

    // 4. growth fraction
    var growth = grid(function (r, c) { return dODcorr[r][c] / ref; });
    var frac = [];
    for (var mr = 0; mr < layout.nRows; mr++) {
      var row = [];
      for (var mc = 0; mc < layout.nCols; mc++) {
        var p = L.matrixPos(layout, mr, mc);
        row.push(growth[p.row][p.col]);
      }
      frac.push(row);
    }

    // 5. drift as % of ref
    var driftPctOfRef = drift.map(function (d) { return d === null ? null : d / ref * 100; });
    var high = driftPctOfRef.some(function (d) { return d !== null && Math.abs(d) > DRIFT_LIMIT * 100; });
    if (high) {
      var listed = driftPctOfRef.map(function (d, i) {
        return d === null ? null : 'ABCDEFGH'[i] + ' ' + d.toFixed(1) + '%';
      }).filter(Boolean);
      warnings.push({ code: 'drift-high', driftPctOfRef: driftPctOfRef,
        message: 'Cell-free drift is above 2% of the reference growth in at least one row (' + listed.join(', ') +
          '). At a 95% cut-off this matters.' });
    }

    // 6. colour stability (informational): inhibited wells at the top concentration of either drug
    if (t0) {
      var wells = [];
      for (var cr = 0; cr < layout.nRows; cr++) {
        for (var cc = 0; cc < layout.nCols; cc++) {
          if (cr !== layout.nRows - 1 && cc !== layout.nCols - 1) continue;
          if (cr === 0 && cc === 0) continue;
          if (!(frac[cr][cc] <= COLOUR_G_MAX)) continue;
          var q = L.matrixPos(layout, cr, cc);
          var od0 = t0[q.row][q.col], odx = tx[q.row][q.col];
          wells.push({ well: L.wellId(q.row, q.col), r: cr, c: cc, od0: od0, odx: odx, relChange: (odx - od0) / od0 });
        }
      }
      if (wells.length) {
        var rel = wells.map(function (w) { return w.relChange * 100; });
        warnings.push({ code: 'colour-stability', info: true, wells: wells,
          message: 'Colour stability: in ' + wells.length + ' inhibited top-concentration well(s), OD changed by ' +
            Math.min.apply(null, rel).toFixed(1) + '% to ' + Math.max.apply(null, rel).toFixed(1) +
            '% of OD at t0 (informational).' });
      }
    }

    return {
      settings: s, odT0: t0, odTx: tx, dOD: dOD, drift: drift, dODcorr: dODcorr,
      ref: ref, refDrugfree: refDrugfree, solventfreeMean: solventfreeMean,
      growth: growth, frac: frac, driftPctOfRef: driftPctOfRef, warnings: warnings,
    };
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    correct: correct,
  };
});

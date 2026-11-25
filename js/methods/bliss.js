/* methods/bliss.js: Bliss excess (SPEC section 8.2).
 * Pure: no DOM access.
 *
 *   E      = 1 − clip(g, 0, 1)          fractional inhibition
 *   E_A    = E[0][c],  E_B = E[r][0]
 *   E_exp  = E_A + E_B − E_A·E_B
 *   excess = E[r][c] − E_exp            for r ≥ 1, c ≥ 1
 *
 * Also exports the shared excess machinery used by hsa.js. */
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
})('methods/bliss', function (need) {
  'use strict';

  var registry = need('methods', './index.js');

  var WINDOW = 3;

  function clip01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  /**
   * Excess over an expected-inhibition model.
   * expected(EA, EB) -> E_exp. Returns, in fractions (× 100 for percentage points):
   *   { E, excess[r-1][c-1] (combination wells only, r ≥ 1, c ≥ 1), mean,
   *     max3x3, max3x3At: {r, c} (top-left combination-well index of the best window, in matrix coords) | null }
   */
  function excessAnalysis(frac, expected) {
    var E = frac.map(function (row) { return row.map(function (g) { return 1 - clip01(g); }); });
    var nR = E.length, nC = E[0].length;
    var X = [], sum = 0, n = 0;
    for (var r = 1; r < nR; r++) {
      var row = [];
      for (var c = 1; c < nC; c++) {
        var x = E[r][c] - expected(E[0][c], E[r][0]);
        row.push(x); sum += x; n++;
      }
      X.push(row);
    }

    var best = null, bestAt = null;
    for (var i = 0; i + WINDOW <= X.length; i++) {
      for (var j = 0; j + WINDOW <= X[0].length; j++) {
        var s = 0;
        for (var a = 0; a < WINDOW; a++) for (var b = 0; b < WINDOW; b++) s += X[i + a][j + b];
        var m = s / (WINDOW * WINDOW);
        if (best === null || m > best) { best = m; bestAt = { r: i + 1, c: j + 1 }; }
      }
    }
    return { E: E, excess: X, mean: n ? sum / n : null, max3x3: best, max3x3At: bestAt };
  }

  function blissExpected(ea, eb) { return ea + eb - ea * eb; }

  var NO_THRESHOLD = 'Bliss has no agreed cut-off; FICI and Bliss can disagree on the same data.';

  /** Build a method module around an expected-inhibition model (shared with HSA). */
  function makeExcessMethod(opts) {
    function run(ctx) {
      var an = excessAnalysis(ctx.frac, opts.expected);
      return {
        method: opts.id,
        excess: an.excess,                 // fractions; [r-1][c-1] for matrix well [r][c]
        mean: an.mean,
        max3x3: an.max3x3,
        max3x3At: an.max3x3At,
        meanPP: an.mean === null ? null : an.mean * 100,
        max3x3PP: an.max3x3 === null ? null : an.max3x3 * 100,
        note: opts.note,
      };
    }

    function toCSV(res) {
      var rows = [];
      function add(metric, value) { rows.push(registry.csvRow([opts.id, metric, value, '', ''])); }
      add('mean_excess_pp', res.meanPP);
      add('max_3x3_mean_excess_pp', res.max3x3PP);
      if (res.max3x3At) {
        add('max_3x3_window_r', res.max3x3At.r);
        add('max_3x3_window_c', res.max3x3At.c);
      }
      res.excess.forEach(function (row, i) {
        row.forEach(function (x, j) { add('excess_pp_r' + (i + 1) + '_c' + (j + 1), x * 100); });
      });
      return rows.join('\n');
    }

    /**
     * Pool per-plate results (SPEC 10): mean ± SD of the per-plate summary scores.
     * The excess heatmaps are averaged well by well only when poolOpts.sameConcs is true
     * (identical concentration lists) and every matrix has the same shape.
     */
    function pool(results, poolOpts) {
      var S = registry.stats;
      var means = results.map(function (r) { return r.meanPP; });
      var maxes = results.map(function (r) { return r.max3x3PP; });
      var out = {
        method: opts.id,
        n: results.length,
        meanPP: { mean: S.mean(means), sd: S.sd(means) },
        max3x3PP: { mean: S.mean(maxes), sd: S.sd(maxes) },
        avgExcess: null,
        avgReason: null,
      };
      var shapes = results.map(function (r) { return r.excess.length + 'x' + (r.excess[0] || []).length; });
      if (!(poolOpts && poolOpts.sameConcs)) out.avgReason = 'Concentrations differ between plates, so the heatmaps are not averaged.';
      else if (new Set(shapes).size !== 1) out.avgReason = 'Matrix sizes differ between plates, so the heatmaps are not averaged.';
      else if (results.length) {
        out.avgExcess = results[0].excess.map(function (row, i) {
          return row.map(function (_, j) { return S.mean(results.map(function (r) { return r.excess[i][j]; })); });
        });
      }
      return out;
    }

    function poolToCSV(p) {
      var s = 'n=' + p.n;
      return [
        [opts.id, 'pooled_mean_excess_pp_mean', p.meanPP.mean, '', s],
        [opts.id, 'pooled_mean_excess_pp_sd', p.meanPP.sd, '', s],
        [opts.id, 'pooled_max_3x3_pp_mean', p.max3x3PP.mean, '', s],
        [opts.id, 'pooled_max_3x3_pp_sd', p.max3x3PP.sd, '', s],
        [opts.id, 'pooled_n', p.n, '', s],
      ].map(registry.csvRow).join('\n');
    }

    return {
      id: opts.id,
      label: opts.label,
      requires: ['endpoint'],
      defaults: {},
      run: run,
      pool: pool,
      toCSV: toCSV,
      poolToCSV: poolToCSV,
      excessAnalysis: function (frac) { return excessAnalysis(frac, opts.expected); },
      NOTE: opts.note,
    };
  }

  var mod = makeExcessMethod({ id: 'bliss', label: 'Bliss excess', expected: blissExpected, note: NO_THRESHOLD });
  mod.makeExcessMethod = makeExcessMethod;
  mod.genericExcessAnalysis = excessAnalysis;
  registry.register(mod);
  return mod;
});

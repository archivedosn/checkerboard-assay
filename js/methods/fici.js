/* methods/fici.js: MIC + FICI + robustness (SPEC section 8.1).
 * Pure: no DOM access.
 *
 * g[r][c]: growth fraction, r indexes B (rows), c indexes A (columns); [0][0] is drug-free,
 * row 0 is A alone, column 0 is B alone. */
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
})('methods/fici', function (need) {
  'use strict';

  var registry = need('methods', './index.js');

  var SENSITIVITY_CUTOFFS = [0.5, 0.8, 0.9, 0.95];
  var NEAR_BAND = 0.02;
  var ODDS_NOTE = 'FICI ≈ 1 cannot distinguish additivity from indifference under the Odds (2003) cut-offs.';
  var FLOOR_MSG = 'This plate cannot detect synergy at this cut-off; lower the concentration ranges.';
  var N1_BANNER = 'Single plate; this is one observation, not a demonstrated interaction.';

  // ------------------------------------------------------------ core
  /** Odds (2003): ≤ 0.5 synergy; 0.5 < FICI ≤ 4 indifference; > 4 antagonism. */
  function oddsClass(f) {
    if (f === null || f === undefined || isNaN(f)) return null;
    return f <= 0.5 ? 'synergy' : (f > 4 ? 'antagonism' : 'indifference');
  }

  function isInhibited(g, cutoff) { return g <= 1 - cutoff; }

  /**
   * Lowest non-zero concentration i such that wells i..end are all inhibited.
   * None qualifies -> off-scale: 2 × top concentration, bound = true.
   */
  function mic(inhibited, conc) {
    for (var i = 1; i < conc.length; i++) {
      if (allFrom(inhibited, i)) return { mic: conc[i], index: i, bound: false };
    }
    return { mic: 2 * conc[conc.length - 1], index: null, bound: true };
  }

  function allFrom(xs, i) {
    for (var k = i; k < xs.length; k++) if (!xs[k]) return false;
    return true;
  }

  /** Python-style tuple order (fici, a, b), as the oracle's min()/max() use. */
  function cmpWell(x, y) {
    return (x.fici - y.fici) || (x.a - y.a) || (x.b - y.b);
  }

  /**
   * Full MIC + FICI analysis at one cut-off.
   * Returns { cutoff, inhibited[r][c], micA, micB (each {mic, index, bound}), boundary: [{r, c, a, b, fici, bound}],
   *           ficiMin, ficiMax (a boundary well or null), class, floor, floorWarning, near: [{r, c, g}] }.
   * A FICI is flagged `bound` when it depends on an off-scale MIC.
   */
  function analyse(frac, A, B, cutoff) {
    var inh = frac.map(function (row) { return row.map(function (g) { return isInhibited(g, cutoff); }); });
    var micA = mic(inh[0], A);
    var micB = mic(inh.map(function (row) { return row[0]; }), B);
    var bound = micA.bound || micB.bound;

    var boundary = [];
    for (var r = 1; r < B.length; r++) {
      if (!(B[r] < micB.mic)) continue;
      for (var c = 1; c < A.length && A[c] <= micA.mic; c++) {
        if (allFrom(inh[r], c)) {
          boundary.push({ r: r, c: c, a: A[c], b: B[r], fici: A[c] / micA.mic + B[r] / micB.mic, bound: bound });
          break;
        }
      }
    }

    var ficiMin = null, ficiMax = null;
    boundary.forEach(function (w) {
      if (!ficiMin || cmpWell(w, ficiMin) < 0) ficiMin = w;
      if (!ficiMax || cmpWell(w, ficiMax) > 0) ficiMax = w;
    });

    var floor = A[1] / micA.mic + B[1] / micB.mic;

    var near = [];
    for (var nr = 0; nr < frac.length; nr++) {
      for (var nc = 0; nc < frac[nr].length; nc++) {
        if (Math.abs(frac[nr][nc] - (1 - cutoff)) <= NEAR_BAND) near.push({ r: nr, c: nc, g: frac[nr][nc] });
      }
    }

    return {
      cutoff: cutoff, inhibited: inh, micA: micA, micB: micB, boundary: boundary,
      ficiMin: ficiMin, ficiMax: ficiMax, class: ficiMin ? oddsClass(ficiMin.fici) : null,
      floor: floor, floorWarning: floor > 0.5 ? FLOOR_MSG : null, near: near,
    };
  }

  /** One summary row for the sensitivity tables. */
  function summaryRow(an) {
    return {
      cutoff: an.cutoff,
      micA: an.micA.mic, boundA: an.micA.bound,
      micB: an.micB.mic, boundB: an.micB.bound,
      ficiMin: an.ficiMin ? an.ficiMin.fici : null,
      ficiMinBound: an.ficiMin ? an.ficiMin.bound : false,
      nBoundary: an.boundary.length,
      class: an.class,
    };
  }

  // ------------------------------------------------------------ robustness (SPEC 8.1 panel)
  /** Step ratio of a dilution series near its top (2 for twofold series). */
  function dilutionFactor(conc) {
    var n = conc.length;
    return n >= 3 && conc[n - 2] > 0 ? conc[n - 1] / conc[n - 2] : 2;
  }

  /**
   * FICImin with MIC_A and MIC_B each moved ±1 dilution (4 combinations).
   * The boundary wells are kept; only the MIC denominators change.
   */
  function dilutionError(an, A, B) {
    if (!an.boundary.length) return null;
    var fa = dilutionFactor(A), fb = dilutionFactor(B);
    var combos = [];
    [fa, 1 / fa].forEach(function (ka) {
      [fb, 1 / fb].forEach(function (kb) {
        var mA = an.micA.mic * ka, mB = an.micB.mic * kb, best = null;
        an.boundary.forEach(function (w) {
          var f = w.a / mA + w.b / mB;
          if (best === null || f < best) best = f;
        });
        combos.push({ micA: mA, micB: mB, ficiMin: best, class: oddsClass(best) });
      });
    });
    var vals = combos.map(function (x) { return x.ficiMin; });
    return { combos: combos, min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
  }

  /**
   * Which reads go in the time-sensitivity table: every single/pasted read, and for kinetic runs one
   * cycle per whole hour since t0 (the cycle nearest each hour, within half an hour).
   * reads must be sorted; returns indices into reads.
   */
  function timeSensitivityReads(reads, t0Index) {
    var t0 = reads[t0Index || 0].start.getTime();
    var keep = [], bestByHour = {};
    reads.forEach(function (rd, i) {
      var h = (rd.start.getTime() - t0) / 3600000;
      if (rd.source !== 'kinetic') { keep.push(i); return; }
      var hr = Math.round(h), d = Math.abs(h - hr);
      if (!(hr in bestByHour) || d < bestByHour[hr].d) bestByHour[hr] = { i: i, d: d };
    });
    Object.keys(bestByHour).forEach(function (k) { keep.push(bestByHour[k].i); });
    if (keep.indexOf(t0Index || 0) < 0) keep.push(t0Index || 0);
    return keep.sort(function (x, y) { return x - y; });
  }

  // ------------------------------------------------------------ method module
  /**
   * ctx = { frac, A, B, settings: { cutoff }, allReadsFrac?: [{ hours, label?, frac }] }
   * allReadsFrac holds the reads chosen by timeSensitivityReads(), corrected with the same settings.
   */
  function run(ctx) {
    var cutoff = ctx.settings && ctx.settings.cutoff !== undefined ? ctx.settings.cutoff : 0.95;
    if (!(cutoff >= 0.5 && cutoff <= 0.99)) throw new Error('Cut-off must be between 0.50 and 0.99.');
    var A = ctx.A, B = ctx.B;
    var an = analyse(ctx.frac, A, B, cutoff);

    var cutoffs = SENSITIVITY_CUTOFFS.slice();
    if (cutoffs.indexOf(cutoff) < 0) cutoffs.push(cutoff);
    cutoffs.sort(function (x, y) { return x - y; });
    var cutoffTable = cutoffs.map(function (k) {
      var row = summaryRow(k === cutoff ? an : analyse(ctx.frac, A, B, k));
      row.current = k === cutoff;
      return row;
    });

    var timeTable = (ctx.allReadsFrac || []).map(function (rd) {
      var row = summaryRow(analyse(rd.frac, A, B, cutoff));
      row.hours = rd.hours;
      row.label = rd.label || null;
      return row;
    });

    return {
      method: 'fici',
      cutoff: cutoff,
      analysis: an,
      micA: an.micA, micB: an.micB,
      boundary: an.boundary,
      ficiMin: an.ficiMin, ficiMax: an.ficiMax,
      class: an.class,
      oddsNote: ODDS_NOTE,
      robustness: {
        floor: an.floor,
        floorWarning: an.floorWarning,
        cutoffTable: cutoffTable,
        timeTable: timeTable,
        near: an.near,
        dilution: dilutionError(an, A, B),
        banner: N1_BANNER,
      },
    };
  }

  function toCSV(res) {
    var settings = 'cutoff=' + res.cutoff;
    var rows = [];
    function add(metric, value, bound) { rows.push(registry.csvRow(['fici', metric, value, bound ? 'bound' : '', settings])); }
    add('MIC_A', res.micA.mic, res.micA.bound);
    add('MIC_B', res.micB.mic, res.micB.bound);
    if (res.ficiMin) {
      add('FICImin', res.ficiMin.fici, res.ficiMin.bound);
      add('FICImin_concA', res.ficiMin.a);
      add('FICImin_concB', res.ficiMin.b);
      add('FICImax', res.ficiMax.fici, res.ficiMax.bound);
      add('FICImax_concA', res.ficiMax.a);
      add('FICImax_concB', res.ficiMax.b);
    }
    add('class', res.class || 'no boundary wells');
    add('boundary_wells', res.boundary.length);
    add('attainable_floor', res.robustness.floor, res.micA.bound || res.micB.bound);
    res.robustness.near.forEach(function (n) { add('near_cutoff_r' + n.r + '_c' + n.c + '_pct', n.g * 100); });
    if (res.robustness.dilution) {
      add('FICImin_dilution_min', res.robustness.dilution.min);
      add('FICImin_dilution_max', res.robustness.dilution.max);
    }
    res.robustness.cutoffTable.forEach(function (t) {
      var s = 'cutoff=' + t.cutoff;
      rows.push(registry.csvRow(['fici', 'sens_MIC_A', t.micA, t.boundA ? 'bound' : '', s]));
      rows.push(registry.csvRow(['fici', 'sens_MIC_B', t.micB, t.boundB ? 'bound' : '', s]));
      rows.push(registry.csvRow(['fici', 'sens_FICImin', t.ficiMin, t.ficiMinBound ? 'bound' : '', s]));
      rows.push(registry.csvRow(['fici', 'sens_class', t.class, '', s]));
    });
    return rows.join('\n');
  }

  /**
   * Pool per-plate results (SPEC 10): median FICImin, range, n, a consistency count, class from the median.
   * Plates without boundary wells count towards n but have no FICImin.
   */
  function pool(results) {
    var S = registry.stats;
    var withF = results.filter(function (r) { return r && r.ficiMin; });
    var vals = withF.map(function (r) { return r.ficiMin.fici; });
    var med = S.median(vals);
    var cls = med === null ? null : oddsClass(med);
    var counts = {};
    results.forEach(function (r) {
      var k = (r && r.class) || 'none';
      counts[k] = (counts[k] || 0) + 1;
    });
    var agree = cls ? (counts[cls] || 0) : 0;
    return {
      method: 'fici',
      n: results.length,
      nWithFici: withF.length,
      medianFiciMin: med,
      min: vals.length ? Math.min.apply(null, vals) : null,
      max: vals.length ? Math.max.apply(null, vals) : null,
      anyBound: withF.some(function (r) { return r.ficiMin.bound; }),
      class: cls,
      classCounts: counts,
      consistency: cls ? cls + ' on ' + agree + ' of ' + results.length + ' plate' + (results.length === 1 ? '' : 's') : null,
      cutoffs: results.map(function (r) { return r ? r.cutoff : null; }),
    };
  }

  function poolToCSV(p) {
    var s = 'n=' + p.n;
    return [
      ['fici', 'pooled_median_FICImin', p.medianFiciMin, p.anyBound ? 'bound' : '', s],
      ['fici', 'pooled_FICImin_min', p.min, '', s],
      ['fici', 'pooled_FICImin_max', p.max, '', s],
      ['fici', 'pooled_class', p.class, '', s],
      ['fici', 'pooled_consistency', p.consistency, '', s],
      ['fici', 'pooled_n', p.n, '', s],
    ].map(registry.csvRow).join('\n');
  }

  var mod = {
    id: 'fici',
    label: 'MIC + FICI',
    requires: ['endpoint'],
    defaults: { cutoff: 0.95 },
    run: run,
    pool: pool,
    toCSV: toCSV,
    poolToCSV: poolToCSV,
    // exposed for tests and other modules
    analyse: analyse,
    mic: mic,
    oddsClass: oddsClass,
    dilutionError: dilutionError,
    timeSensitivityReads: timeSensitivityReads,
    SENSITIVITY_CUTOFFS: SENSITIVITY_CUTOFFS,
    ODDS_NOTE: ODDS_NOTE,
    FLOOR_MSG: FLOOR_MSG,
    N1_BANNER: N1_BANNER,
  };
  registry.register(mod);
  return mod;
});

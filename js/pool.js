/* pool.js: Repeat grouping and pooled summaries (SPEC section 10).
 * Pure: no DOM access.
 *
 * Plates group automatically when the drug pair (names and units) and the A/B concentration lists match.
 * A plate's `group` field (a non-empty label) overrides this: plates sharing a label form one group.
 * Pooled numbers come from each method's own pool() (see methods/index.js). */
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
})('pool', function (need) {
  'use strict';

  var registry = need('methods', './methods/index.js');

  var FEWER_THAN_3 = 'Fewer than 3 independent repeats.';

  function norm(s) { return String(s || '').trim().toLowerCase(); }

  /** Automatic grouping key: drug pair (names + units) and both concentration lists. */
  function autoKey(pair, layout) {
    return JSON.stringify([norm(pair.A.name), norm(pair.A.unit), norm(pair.B.name), norm(pair.B.unit), layout.A, layout.B]);
  }

  function sameList(x, y) {
    return x.length === y.length && x.every(function (v, i) { return v === y[i]; });
  }

  /**
   * plates: [{ id, pair, group?, layoutId }]; getLayout(plate) -> Layout | null.
   * Returns groups in order of first appearance:
   *   [{ key, label, custom, plateIds, sameConcs }]
   * Plates without a usable layout are left out.
   */
  function groupPlates(plates, getLayout) {
    var groups = [], byKey = {};
    plates.forEach(function (p) {
      var layout = getLayout(p);
      if (!layout || !p.pair) return;
      var custom = typeof p.group === 'string' && p.group.trim() !== '';
      var key = custom ? 'custom:' + p.group.trim() : 'auto:' + autoKey(p.pair, layout);
      if (!byKey[key]) {
        byKey[key] = {
          key: key,
          label: custom ? p.group.trim() : autoLabel(p.pair, layout),
          custom: custom,
          plateIds: [],
          layouts: [],
        };
        groups.push(byKey[key]);
      }
      byKey[key].plateIds.push(p.id);
      byKey[key].layouts.push(layout);
    });
    groups.forEach(function (g) {
      var l0 = g.layouts[0];
      g.sameConcs = g.layouts.every(function (l) { return sameList(l.A, l0.A) && sameList(l.B, l0.B); });
      delete g.layouts;
    });
    return groups;
  }

  function fmt(x) { return String(+x.toPrecision(3)); }

  function autoLabel(pair, layout) {
    return pair.A.name + ' + ' + pair.B.name + ' · ' + layout.nCols + '×' + layout.nRows +
      ' (' + pair.A.name + ' to ' + fmt(layout.A[layout.A.length - 1]) + ' ' + pair.A.unit + ', ' +
      pair.B.name + ' to ' + fmt(layout.B[layout.B.length - 1]) + ' ' + pair.B.unit + ')';
  }

  /**
   * Pool one group. entries: [{ plateId, results: { [methodId]: Result } }].
   * Returns { n, fewerThan3, message, methods: { [methodId]: PooledResult } }.
   */
  function poolGroup(entries, opts) {
    opts = opts || {};
    var n = entries.length;
    var methods = {};
    registry.list().forEach(function (m) {
      if (!m.pool) return;
      var rs = entries.map(function (e) { return e.results[m.id]; }).filter(Boolean);
      if (rs.length) methods[m.id] = m.pool(rs, { sameConcs: !!opts.sameConcs });
    });
    return { n: n, fewerThan3: n < 3, message: n < 3 ? FEWER_THAN_3 : null, methods: methods };
  }

  /** Pooled CSV for a group (rows use the results.csv columns). */
  function pooledCSV(pooled) {
    var lines = [registry.CSV_HEADER];
    Object.keys(pooled.methods).forEach(function (id) {
      var m = registry.get(id);
      if (m && m.poolToCSV) lines.push(m.poolToCSV(pooled.methods[id]));
    });
    return lines.join('\n') + '\n';
  }

  return {
    FEWER_THAN_3: FEWER_THAN_3,
    autoKey: autoKey,
    groupPlates: groupPlates,
    poolGroup: poolGroup,
    pooledCSV: pooledCSV,
  };
});

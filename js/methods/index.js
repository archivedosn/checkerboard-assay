/* methods/index.js: Method registry, the extension point (SPEC section 3.2).
 * Pure: no DOM access.
 *
 * A method module is { id, label, requires, defaults, run(ctx) -> Result, pool?(results) -> PooledResult,
 *                      toCSV(result) -> string }.
 * Its renderer lives in index.html's script, keyed by id.
 * ctx = { frac, A, B, settings, plate, allReadsFrac }
 *
 * Each method file registers itself when loaded, so adding a method means adding one file
 * (plus its <script> tag and renderer). Node callers can use loadAll() to load every file in this folder. */
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
})('methods', function (need) {
  'use strict';

  var registry = [];

  function register(mod) {
    ['id', 'label', 'run', 'toCSV'].forEach(function (k) {
      if (!mod[k]) throw new Error('Method module is missing "' + k + '"');
    });
    var i = indexOf(mod.id);
    if (i >= 0) registry[i] = mod; else registry.push(mod);
    return mod;
  }

  function indexOf(id) {
    for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return i;
    return -1;
  }

  function get(id) { var i = indexOf(id); return i < 0 ? null : registry[i]; }
  function list() { return registry.slice(); }

  /** Node only: require every method file next to this one (each registers itself). */
  function loadAll() {
    var fs = require('fs'), path = require('path');
    fs.readdirSync(__dirname).filter(function (f) { return /\.js$/.test(f) && f !== 'index.js'; })
      .sort().forEach(function (f) { require(path.join(__dirname, f)); });
    return list();
  }

  // ------------------------------------------------------------ CSV helpers shared by methods
  var CSV_HEADER = 'method,metric,value,bound,settings';

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    // numbers: 15 significant digits drops floating-point noise (1.2764000000000002 -> 1.2764)
    var s = typeof v === 'number' ? (isFinite(v) ? String(Number(v.toPrecision(15))) : '') : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvRow(cells) { return cells.map(csvCell).join(','); }

  // ------------------------------------------------------------ summary statistics shared by pool() functions
  function finite(xs) { return xs.filter(function (x) { return typeof x === 'number' && isFinite(x); }); }

  function median(xs) {
    var v = finite(xs).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function mean(xs) {
    var v = finite(xs);
    return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null;
  }

  /** Sample standard deviation (n − 1); null when n < 2. */
  function sd(xs) {
    var v = finite(xs);
    if (v.length < 2) return null;
    var m = mean(v);
    return Math.sqrt(v.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (v.length - 1));
  }

  return {
    register: register,
    get: get,
    list: list,
    loadAll: loadAll,
    CSV_HEADER: CSV_HEADER,
    csvRow: csvRow,
    stats: { median: median, mean: mean, sd: sd, finite: finite },
  };
});

/* export.js: CSV / SVG / PNG / session JSON (SPEC section 12).
 * The CSV, SVG-string and session functions are pure and run under Node.
 * download() and svgToPng() touch the DOM, and only when called. */
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
})('export', function (need) {
  'use strict';

  var L = need('layout', './layout.js');
  var registry = need('methods', './methods/index.js');

  var SCHEMA = 'checkerboard-session/1';

  // ------------------------------------------------------------ helpers
  var csvRow = registry.csvRow;

  /** File-name-safe version of a label. */
  function safeName(s) {
    var out = String(s || '').trim().replace(/[^A-Za-z0-9._+-]+/g, '_').replace(/^_+|_+$/g, '');
    return out || 'plate';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localStamp(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ------------------------------------------------------------ *_growth.csv
  /**
   * One row per well (96).
   * opts = { layout, pair, corr } where corr is the output of correct.correct().
   */
  function growthCSV(opts) {
    var l = opts.layout, pair = opts.pair, k = opts.corr;
    var head = ['well', 'row', 'col',
      'conc_A (' + pair.A.name + ', ' + pair.A.unit + ')', 'conc_B (' + pair.B.name + ', ' + pair.B.unit + ')',
      'role', 'OD_t0', 'OD_tx', 'dOD', 'drift', 'dOD_corr', 'growth_fraction'];
    var lines = [csvRow(head)];
    for (var r = 0; r < L.PLATE_ROWS; r++) {
      for (var c = 0; c < L.PLATE_COLS; c++) {
        var id = L.wellId(r, c), m = L.matrixIndex(l, r, c);
        lines.push(csvRow([
          id, 'ABCDEFGH'[r], c + 1,
          m ? l.A[m.c] : '', m ? l.B[m.r] : '',
          L.roleOf(l, id),
          k.odT0 ? k.odT0[r][c] : '', k.odTx[r][c],
          k.dOD[r][c], k.drift[r] === null ? '' : k.drift[r],
          k.dODcorr[r][c], k.growth[r][c],
        ]));
      }
    }
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------ *_results.csv
  /**
   * opts = { plateName, layout, pair, t0, tx, hours, settings, corr, results: { [methodId]: Result } }
   * Context rows first (method 'plate' and 'correction'), then each method's own toCSV().
   */
  function resultsCSV(opts) {
    var s = opts.settings;
    var lines = [registry.CSV_HEADER];
    function ctx(method, metric, value) { lines.push(csvRow([method, metric, value, '', ''])); }
    ctx('plate', 'name', opts.plateName);
    ctx('plate', 'layout', opts.layout.name);
    ctx('plate', 'drug_A', opts.pair.A.name + ' (' + opts.pair.A.unit + ')');
    ctx('plate', 'drug_B', opts.pair.B.name + ' (' + opts.pair.B.unit + ')');
    ctx('plate', 't0_file', opts.t0.file);
    ctx('plate', 't0_start', localStamp(opts.t0.start));
    ctx('plate', 'analysis_file', opts.tx.file);
    ctx('plate', 'analysis_start', localStamp(opts.tx.start));
    ctx('plate', 'hours_since_t0', opts.hours);
    ctx('correction', 'useT0', s.useT0);
    ctx('correction', 'useDrift', s.useDrift);
    ctx('correction', 'reference', s.reference);
    ctx('correction', 'reference_dOD', opts.corr.ref);
    (opts.corr.driftPctOfRef || []).forEach(function (d, r) {
      if (d !== null) ctx('correction', 'drift_pct_of_ref_row_' + 'ABCDEFGH'[r], d);
    });
    opts.corr.warnings.forEach(function (w) { ctx('warning', w.code, w.message); });
    Object.keys(opts.results).forEach(function (id) {
      var m = registry.get(id);
      if (m) lines.push(m.toCSV(opts.results[id]));
    });
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------ *_pooled.csv
  /**
   * Long format so that any registered method appears without changes here.
   * entries = [{ plateName, results }], pooled = pool.poolGroup() output.
   */
  function pooledCSV(entries, pooled, groupLabel) {
    var lines = [csvRow(['group', 'plate'].concat(registry.CSV_HEADER.split(',')))];
    function prefix(block, plateName) {
      block.split('\n').filter(Boolean).forEach(function (line) {
        lines.push(csvRow([groupLabel, plateName]) + ',' + line);
      });
    }
    entries.forEach(function (e) {
      Object.keys(e.results).forEach(function (id) {
        var m = registry.get(id);
        if (m) prefix(m.toCSV(e.results[id]), e.plateName);
      });
    });
    Object.keys(pooled.methods).forEach(function (id) {
      var m = registry.get(id);
      if (m && m.poolToCSV) prefix(m.poolToCSV(pooled.methods[id]), 'POOLED');
    });
    lines.push(csvRow([groupLabel, 'POOLED', 'group', 'n', pooled.n, '', pooled.message || '']));
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------ SVG / PNG
  /**
   * Standalone SVG text for a heatmap: adds a white background, an optional caption line,
   * and a <style> block (the page's CSS does not travel with the file). Drops the focus ring.
   * caption: a string or an array of lines (short lines avoid clipping on narrow heatmaps).
   * svgText: outerHTML of the on-screen <svg>; width/height: its size in px.
   */
  function captionLines(caption) {
    return Array.isArray(caption) ? caption.filter(Boolean) : (caption ? [caption] : []);
  }

  /** Extra height the caption adds above the heatmap (one line = 24 px, +18 px per further line). */
  function captionHeight(caption) {
    var n = captionLines(caption).length;
    return n ? 6 + 18 * n : 0;
  }

  function standaloneSVG(svgText, width, height, css, caption) {
    var lines = captionLines(caption);
    var capH = captionHeight(caption);
    var inner = String(svgText)
      .replace(/^<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/<rect[^>]*class="focus-ring"[^>]*\/?>(<\/rect>)?/g, '');
    var W = width, H = height + capH;
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<style>' + css + '</style>' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>' +
      lines.map(function (t, i) {
        return '<text x="8" y="' + (17 + 18 * i) + '" class="caption' + (i ? ' caption-sub' : '') + '">' + escXML(t) + '</text>';
      }).join('') +
      '<g transform="translate(0,' + capH + ')">' + inner + '</g></svg>';
  }

  function escXML(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch];
    });
  }

  /** Browser only: render SVG text to a PNG Blob at `scale` × size (default 2×). */
  function svgToPng(svgText, width, height, scale) {
    scale = scale || 2;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        var g = canvas.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('PNG encoding failed')); }, 'image/png');
      };
      img.onerror = function () { reject(new Error('Could not render the SVG')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    });
  }

  /** Browser only: save a Blob or string via a temporary a[download]. */
  function download(data, filename, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ------------------------------------------------------------ session JSON
  /**
   * state = { settings, enabled?, layouts: Layout[] (custom ones), plates: Plate[] }
   * Raw reads are stored, never derived values, so results recompute under the current code.
   */
  function sessionToJSON(state, now) {
    return {
      schema: SCHEMA,
      exported: (now || new Date()).toISOString(),
      settings: Object.assign({}, state.settings),
      enabled: Object.assign({}, state.enabled || {}),
      layouts: (state.layouts || []).map(function (l) { return JSON.parse(JSON.stringify(l)); }),
      plates: state.plates.map(function (p) {
        return {
          id: p.id, name: p.name, pair: p.pair ? JSON.parse(JSON.stringify(p.pair)) : null,
          layoutId: p.layoutId, group: p.group || '',
          t0Index: p.t0Index, analysisReadIndex: p.analysisReadIndex,
          reads: p.reads.map(function (r) {
            var o = { start: r.start.toISOString(), source: r.source, file: r.file,
              grid: r.grid.map(function (row) { return row.map(function (x) { return isFinite(x) ? x : null; }); }) };
            if (r.cycle !== undefined) o.cycle = r.cycle;
            if (r.lid !== undefined) o.lid = r.lid;
            if (r.temp !== undefined) o.temp = r.temp;
            return o;
          }),
        };
      }),
    };
  }

  /**
   * Validate a parsed session object and rebuild it. Throws with a clear message on any problem.
   * knownLayout(id) -> bool tells whether a layout id exists outside the file (e.g. a preset).
   * Returns { settings, enabled, layouts, plates }.
   */
  function sessionFromJSON(o, knownLayout) {
    if (!o || typeof o !== 'object') throw new Error('Not a session file.');
    if (o.schema !== SCHEMA) throw new Error('Unknown schema "' + o.schema + '" (expected ' + SCHEMA + ').');
    if (!Array.isArray(o.plates)) throw new Error('Session has no plates list.');

    var layouts = (o.layouts || []).map(function (l) { return L.fromJSON(l); });
    var ids = {};
    layouts.forEach(function (l) { ids[l.id] = true; });

    var s = o.settings || {};
    var settings = {
      cutoff: typeof s.cutoff === 'number' && s.cutoff >= 0.5 && s.cutoff <= 0.99 ? s.cutoff : 0.95,
      useT0: s.useT0 !== false,
      useDrift: s.useDrift !== false,
      reference: s.reference === 'solventfreeMean' ? 'solventfreeMean' : 'drugfree',
    };

    var plates = o.plates.map(function (p, pi) {
      var where = 'Plate ' + (pi + 1) + (p && p.name ? ' ("' + p.name + '")' : '');
      if (!p || typeof p !== 'object') throw new Error(where + ' is not an object.');
      if (!ids[p.layoutId] && !(knownLayout && knownLayout(p.layoutId))) {
        throw new Error(where + ' uses layout "' + p.layoutId + '", which is neither a preset nor in the file.');
      }
      if (!Array.isArray(p.reads)) throw new Error(where + ' has no reads list.');
      var reads = p.reads.map(function (r, ri) {
        var rw = where + ', read ' + (ri + 1);
        var start = new Date(r && r.start);
        if (!r || isNaN(start.getTime())) throw new Error(rw + ': bad start time.');
        if (!Array.isArray(r.grid) || r.grid.length !== 8 || !r.grid.every(function (row) {
          return Array.isArray(row) && row.length === 12 && row.every(function (x) { return x === null || (typeof x === 'number' && isFinite(x)); });
        })) throw new Error(rw + ': grid must be 8 rows of 12 numbers.');
        if (['single', 'kinetic', 'pasted'].indexOf(r.source) < 0) throw new Error(rw + ': unknown source "' + r.source + '".');
        var read = { start: start, source: r.source, file: String(r.file || ''),
          grid: r.grid.map(function (row) { return row.map(function (x) { return x === null ? NaN : x; }); }) };
        if (typeof r.cycle === 'number') read.cycle = r.cycle;
        if (typeof r.lid === 'string') read.lid = r.lid;
        if (typeof r.temp === 'number') read.temp = r.temp;
        return read;
      }).sort(function (a, b) { return a.start - b.start; });
      var n = reads.length;
      var okIndex = function (i, d) { return Number.isInteger(i) && i >= 0 && i < n ? i : d; };
      return {
        id: String(p.id || 'p' + (pi + 1)), name: String(p.name || 'Plate ' + (pi + 1)),
        pair: p.pair && p.pair.A && p.pair.B ? {
          A: { name: String(p.pair.A.name || ''), unit: String(p.pair.A.unit || '') },
          B: { name: String(p.pair.B.name || ''), unit: String(p.pair.B.unit || '') },
        } : null,
        layoutId: p.layoutId, group: typeof p.group === 'string' ? p.group : '',
        reads: reads,
        t0Index: okIndex(p.t0Index, 0), analysisReadIndex: okIndex(p.analysisReadIndex, Math.max(0, n - 1)),
      };
    });

    var enabled = {};
    Object.keys(o.enabled || {}).forEach(function (k) { enabled[k] = !!o.enabled[k]; });
    return { settings: settings, enabled: enabled, layouts: layouts, plates: plates };
  }

  return {
    SCHEMA: SCHEMA,
    safeName: safeName,
    growthCSV: growthCSV,
    resultsCSV: resultsCSV,
    pooledCSV: pooledCSV,
    standaloneSVG: standaloneSVG,
    captionHeight: captionHeight,
    svgToPng: svgToPng,
    download: download,
    sessionToJSON: sessionToJSON,
    sessionFromJSON: sessionFromJSON,
  };
});

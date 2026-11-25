/* layout.js: Layout presets, editor model, well-role lookup (SPEC section 6).
 * Pure: no DOM access.
 *
 * Layout = { id, name, nRows, nCols,                 matrix size (B along rows, A along columns)
 *            matrixOrigin: {row, col},               plate position of matrix [0][0] (the drug-free well)
 *            A: number[], B: number[],               concentrations, each starting at 0
 *            pair?: {A:{name,unit}, B:{name,unit}},  default drug names (the plate can override)
 *            roles: { [wellId]: 'drugfree'|'cellfree'|'solventfree'|'sterile'|'unused' },
 *            cellfreeByRow?: { [plateRow]: wellId } } per-row no-cell wells (plateRow 0 = A)
 * Matrix wells other than the drug-free well have no entry in `roles`; roleOf() reports them as 'matrix'. */
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
})('layout', function (need) {
  'use strict';

  var PLATE_ROWS = 8, PLATE_COLS = 12;
  var ROW_LETTERS = 'ABCDEFGH';
  var ROLES = ['drugfree', 'cellfree', 'solventfree', 'sterile', 'unused'];

  // ------------------------------------------------------------ well ids
  function wellId(row, col) { return ROW_LETTERS[row] + (col + 1); }

  function parseWellId(id) {
    var m = /^([A-H])(\d{1,2})$/.exec(String(id).trim().toUpperCase());
    if (!m) return null;
    var col = +m[2] - 1;
    if (col < 0 || col >= PLATE_COLS) return null;
    return { row: ROW_LETTERS.indexOf(m[1]), col: col };
  }

  // ------------------------------------------------------------ presets (SPEC 6.1, exact)
  var CF8 = [0, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2];
  var CLZ8 = [0, 1.5625, 3.125, 6.25, 12.5, 25, 50, 100];
  var CF10 = [0, 0.0078125, 0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2];
  var CLZ10 = [0, 0.390625, 0.78125, 1.5625, 3.125, 6.25, 12.5, 25];
  var PCC10 = [0, 0.1875, 0.375, 0.75, 1.5, 3, 6, 12];

  var CF = { name: 'CF', unit: 'µg/mL' };
  var CLZ = { name: 'CLZ', unit: 'µM' };
  var PCC = { name: 'PCC', unit: 'µM' };

  /** Build a layout's role map from column/row assignments. spec.cols: { plateCol: role | [role per row] } */
  function buildRoles(drugfree, cols) {
    var roles = {}, cellfreeByRow = {};
    roles[drugfree] = 'drugfree';
    Object.keys(cols).forEach(function (k) {
      var col = +k, v = cols[k];
      for (var r = 0; r < PLATE_ROWS; r++) {
        var role = Array.isArray(v) ? v[r] : v;
        var id = wellId(r, col);
        roles[id] = role;
        if (role === 'cellfree') cellfreeByRow[r] = id;
      }
    });
    return { roles: roles, cellfreeByRow: cellfreeByRow };
  }

  function preset(id, name, A, B, pair, cols) {
    var rc = buildRoles('A1', cols);
    return deepFreeze({
      id: id, name: name, preset: true,
      nRows: B.length, nCols: A.length,
      matrixOrigin: { row: 0, col: 0 },
      A: A.slice(), B: B.slice(),
      pair: { A: Object.assign({}, pair.A), B: Object.assign({}, pair.B) },
      roles: rc.roles, cellfreeByRow: rc.cellfreeByRow,
    });
  }

  function deepFreeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]); });
    return Object.freeze(o);
  }

  var SF4_STERILE4 = ['solventfree', 'solventfree', 'solventfree', 'solventfree',
    'sterile', 'sterile', 'sterile', 'sterile'];

  var PRESETS = [
    // 1104 – 8×8: CF cols 1–8, CLZ rows A–H; col 9 cell-free, col 10 solvent-free, cols 11–12 sterile.
    preset('p1104-8x8', '1104 – 8×8 (CF + CLZ)', CF8, CLZ8, { A: CF, B: CLZ },
      { 8: 'cellfree', 9: 'solventfree', 10: 'sterile', 11: 'sterile' }),
    // 1109 – 10×8: CF cols 1–10; col 11 cell-free; col 12 rows A–D solvent-free, E–H sterile YPD.
    // One preset per drug pair, since the B concentrations differ.
    preset('p1109-10x8-clz', '1109 – 10×8 (CF + CLZ)', CF10, CLZ10, { A: CF, B: CLZ },
      { 10: 'cellfree', 11: SF4_STERILE4 }),
    preset('p1109-10x8-pcc', '1109 – 10×8 (CF + PCC)', CF10, PCC10, { A: CF, B: PCC },
      { 10: 'cellfree', 11: SF4_STERILE4 }),
  ];

  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  // ------------------------------------------------------------ lookup
  /** Plate {row, col} of matrix well [r][c] (r indexes B, c indexes A). */
  function matrixPos(layout, r, c) {
    return { row: layout.matrixOrigin.row + r, col: layout.matrixOrigin.col + c };
  }

  function matrixWellId(layout, r, c) {
    var p = matrixPos(layout, r, c);
    return wellId(p.row, p.col);
  }

  /** Matrix index {r, c} of a plate well, or null if it is outside the matrix. */
  function matrixIndex(layout, row, col) {
    var r = row - layout.matrixOrigin.row, c = col - layout.matrixOrigin.col;
    return r >= 0 && r < layout.nRows && c >= 0 && c < layout.nCols ? { r: r, c: c } : null;
  }

  /** 'drugfree' | 'matrix' | 'cellfree' | 'solventfree' | 'sterile' | 'unused' */
  function roleOf(layout, id) {
    var role = layout.roles[id];
    if (role) return role;
    var p = parseWellId(id);
    if (p && matrixIndex(layout, p.row, p.col)) return 'matrix';
    return 'unused';
  }

  function wellsWithRole(layout, role) {
    var out = [];
    for (var row = 0; row < PLATE_ROWS; row++) {
      for (var col = 0; col < PLATE_COLS; col++) {
        var id = wellId(row, col);
        if (roleOf(layout, id) === role) out.push(id);
      }
    }
    return out;
  }

  /** Cell-free well id for a plate row (0 = A), or null. */
  function cellfreeForRow(layout, plateRow) {
    var id = layout.cellfreeByRow && layout.cellfreeByRow[plateRow];
    return id || null;
  }

  // ------------------------------------------------------------ validation (SPEC 6.2)
  /** Returns a list of error strings; empty means valid. opts.useDrift: require per-row cell-free wells. */
  function validate(layout, opts) {
    opts = opts || {};
    var errs = [];
    var o = layout.matrixOrigin || { row: 0, col: 0 };

    if (!(layout.nRows >= 2 && layout.nCols >= 2)) errs.push('Matrix must be at least 2 × 2.');
    if (o.row < 0 || o.col < 0 || o.row + layout.nRows > PLATE_ROWS || o.col + layout.nCols > PLATE_COLS) {
      errs.push('Matrix does not fit on a 96-well plate.');
    }

    [['A', layout.nCols], ['B', layout.nRows]].forEach(function (d) {
      var xs = layout[d[0]];
      if (!Array.isArray(xs) || xs.length !== d[1]) {
        errs.push('Drug ' + d[0] + ' needs ' + d[1] + ' concentrations.');
        return;
      }
      if (xs[0] !== 0) errs.push('Drug ' + d[0] + ': the first concentration must be 0.');
      for (var i = 1; i < xs.length; i++) {
        if (!(typeof xs[i] === 'number' && isFinite(xs[i]) && xs[i] > xs[i - 1])) {
          errs.push('Drug ' + d[0] + ': concentrations must be strictly increasing.');
          break;
        }
      }
    });

    var bad = Object.keys(layout.roles).filter(function (id) {
      return !parseWellId(id) || ROLES.indexOf(layout.roles[id]) < 0;
    });
    if (bad.length) errs.push('Unknown wells or roles: ' + bad.join(', ') + '.');

    var drugfree = wellsWithRole(layout, 'drugfree');
    if (drugfree.length !== 1) errs.push('There must be exactly one drug-free well (found ' + drugfree.length + ').');
    else if (drugfree[0] !== wellId(o.row, o.col)) errs.push('The drug-free well must be the matrix top-left well.');

    // Wells with a role other than drug-free may not sit inside the matrix.
    var clash = Object.keys(layout.roles).filter(function (id) {
      var p = parseWellId(id);
      return p && layout.roles[id] !== 'drugfree' && matrixIndex(layout, p.row, p.col);
    });
    if (clash.length) errs.push('Wells inside the matrix cannot have another role: ' + clash.join(', ') + '.');

    // cellfreeByRow must agree with roles.
    Object.keys(layout.cellfreeByRow || {}).forEach(function (row) {
      var id = layout.cellfreeByRow[row], p = parseWellId(id);
      if (!p || p.row !== +row || layout.roles[id] !== 'cellfree') {
        errs.push('Cell-free well ' + id + ' does not match row ' + ROW_LETTERS[row] + '.');
      }
    });

    if (opts.useDrift) {
      var missing = [];
      for (var r = 0; r < layout.nRows; r++) {
        var plateRow = o.row + r;
        if (!cellfreeForRow(layout, plateRow)) missing.push(ROW_LETTERS[plateRow]);
      }
      if (missing.length) errs.push('Drift correction needs a cell-free well in every matrix row; missing: ' + missing.join(', ') + '.');
    }
    return errs;
  }

  /** Deep copy, safe to edit (presets are frozen). */
  function clone(layout) {
    return JSON.parse(JSON.stringify(layout));
  }

  // ------------------------------------------------------------ editor model (SPEC 6.2)
  /**
   * Dilution series: [0, top/f^(steps−1), …, top/f, top]. `steps` counts the non-zero concentrations,
   * so the matrix dimension is steps + 1.
   */
  function concSeries(top, factor, steps) {
    if (!(top > 0 && factor > 1 && steps >= 1 && Math.floor(steps) === steps)) {
      throw new Error('Series needs a top concentration > 0, a dilution factor > 1 and a whole number of steps ≥ 1.');
    }
    var out = [0];
    for (var k = steps - 1; k >= 0; k--) out.push(top / Math.pow(factor, k));
    return out;
  }

  /** Typed list (commas, semicolons, spaces or new lines). A leading 0 is added if missing. */
  function parseConcList(text) {
    var toks = String(text).split(/[\s,;]+/).filter(function (t) { return t !== ''; });
    var xs = toks.map(function (t) {
      var x = Number(t);
      if (!isFinite(x)) throw new Error('"' + t + '" is not a number.');
      return x;
    });
    if (!xs.length) throw new Error('Enter at least one concentration.');
    if (xs[0] !== 0) xs.unshift(0);
    return xs;
  }

  /**
   * Build a layout from editor input. The drug-free well sets the matrix origin;
   * per-row cell-free wells are read from the role map.
   * spec = { id, name, A: number[], B: number[], pair, roles: { wellId: role } }
   * Returns { layout, errors } (layout is null when it cannot be built).
   */
  function buildLayout(spec, opts) {
    var roles = {};
    Object.keys(spec.roles || {}).forEach(function (id) {
      var role = spec.roles[id];
      if (role && role !== 'unused') roles[String(id).toUpperCase()] = role;
    });
    var dfs = Object.keys(roles).filter(function (id) { return roles[id] === 'drugfree'; });
    var origin = dfs.length ? parseWellId(dfs[0]) : { row: 0, col: 0 };

    var cellfreeByRow = {}, errs = [];
    Object.keys(roles).forEach(function (id) {
      if (roles[id] !== 'cellfree') return;
      var p = parseWellId(id);
      if (!p) return;
      if (cellfreeByRow[p.row] !== undefined) errs.push('Row ' + ROW_LETTERS[p.row] + ' has more than one cell-free well.');
      else cellfreeByRow[p.row] = id;
    });

    var layout = {
      id: spec.id, name: spec.name || 'Custom layout',
      nRows: (spec.B || []).length, nCols: (spec.A || []).length,
      matrixOrigin: { row: origin.row, col: origin.col },
      A: (spec.A || []).slice(), B: (spec.B || []).slice(),
      pair: JSON.parse(JSON.stringify(spec.pair || { A: { name: 'A', unit: '' }, B: { name: 'B', unit: '' } })),
      roles: roles, cellfreeByRow: cellfreeByRow,
    };
    if (!String(layout.name).trim()) errs.push('Give the layout a name.');
    ['A', 'B'].forEach(function (k) {
      if (!String(layout.pair[k].name || '').trim()) errs.push('Drug ' + k + ' needs a name.');
    });
    errs = errs.concat(validate(layout, opts));
    return { layout: layout, errors: errs };
  }

  /**
   * Check and normalise a layout read from storage or a session file.
   * Throws on a malformed object; returns a fresh layout object otherwise.
   */
  function fromJSON(o) {
    if (!o || typeof o !== 'object') throw new Error('Layout is not an object.');
    if (typeof o.id !== 'string' || !o.id) throw new Error('Layout has no id.');
    ['A', 'B'].forEach(function (k) {
      if (!Array.isArray(o[k]) || !o[k].every(function (x) { return typeof x === 'number' && isFinite(x); })) {
        throw new Error('Layout ' + o.id + ': ' + k + ' must be a list of numbers.');
      }
    });
    if (!o.roles || typeof o.roles !== 'object') throw new Error('Layout ' + o.id + ' has no roles.');
    var built = buildLayout({ id: o.id, name: o.name, A: o.A, B: o.B, pair: o.pair, roles: o.roles });
    var errs = built.errors.filter(function (e) { return !/^Drug [AB] needs a name/.test(e); });
    if (errs.length) throw new Error('Layout ' + o.id + ': ' + errs.join(' '));
    return built.layout;
  }

  return {
    PLATE_ROWS: PLATE_ROWS, PLATE_COLS: PLATE_COLS, ROLES: ROLES,
    PRESETS: PRESETS,
    getPreset: getPreset,
    concSeries: concSeries,
    parseConcList: parseConcList,
    buildLayout: buildLayout,
    fromJSON: fromJSON,
    wellId: wellId,
    parseWellId: parseWellId,
    matrixPos: matrixPos,
    matrixWellId: matrixWellId,
    matrixIndex: matrixIndex,
    roleOf: roleOf,
    wellsWithRole: wellsWithRole,
    cellfreeForRow: cellfreeForRow,
    validate: validate,
    clone: clone,
  };
});

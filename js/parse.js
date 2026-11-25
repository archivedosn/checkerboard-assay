/* parse.js: Tecan Spark .xlsx and pasted-grid parsing -> Read objects (SPEC section 4).
 * Pure: no DOM access.
 *
 * Read = { start: Date, grid: number[8][12], source: 'single'|'kinetic'|'pasted', file: string,
 *          cycle?: number, lid?: string, temp?: number }
 * Non-numeric well values (e.g. an overflow marker) become NaN and produce a warning. */
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
})('parse', function (need) {
  'use strict';

  var ROWS = 'ABCDEFGH';
  var N_ROWS = 8, N_COLS = 12;

  // SheetJS: vendored copy under Node, the global XLSX in the browser. Loaded lazily.
  function getXLSX() {
    if (typeof module === 'object' && module.exports) return require('./vendor/xlsx.full.min.js');
    if (globalThis.XLSX) return globalThis.XLSX;
    throw new Error('SheetJS (XLSX) is not loaded');
  }

  // ------------------------------------------------------------ cell helpers
  function isEmpty(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  /** Non-empty cells of a row as [{col, v}], with strings trimmed. */
  function cellsOf(row) {
    var out = [];
    for (var j = 0; j < (row ? row.length : 0); j++) {
      var v = row[j];
      if (isEmpty(v)) continue;
      out.push({ col: j, v: typeof v === 'string' ? v.trim() : v });
    }
    return out;
  }

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return NaN;
  }

  /** Spark writes 'YYYY-MM-DD HH:MM:SS' as text. Interpreted as local wall-clock time. */
  function parseTimestamp(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  function wellId(r, c) { return ROWS[r] + (c + 1); }

  // ------------------------------------------------------------ Spark rows -> reads
  /**
   * Parse the rows of a Spark "Result sheet" (array of arrays of cell values).
   * Returns { reads: Read[], warnings: string[] }. Throws if no readings are found
   * or a data block has no Start Time before it.
   */
  function parseSparkRows(rows, file) {
    file = file || '';
    var reads = [], warnings = [];
    var lastStart = null, lastStartRow = -1, lastTemp = null, lid = null;

    function warn(msg) { warnings.push(file + ': ' + msg); }
    function requireStart(i) {
      if (!lastStart) throw new Error(file + ': data block at row ' + (i + 1) + ' has no Start Time before it');
      return lastStart;
    }

    for (var i = 0; i < rows.length; i++) {
      var cells = cellsOf(rows[i]);
      if (!cells.length) continue;
      var head = cells[0].v;
      if (typeof head !== 'string') continue;

      if (head === 'Start Time') {
        var ts = cells.length > 1 ? parseTimestamp(cells[1].v) : null;
        if (!ts) throw new Error(file + ': unreadable Start Time at row ' + (i + 1));
        lastStart = ts; lastStartRow = i; lastTemp = null;
      } else if (head === 'Lid lifter') {
        if (cells.length > 1) lid = String(cells[1].v);
      } else if (head === 'Temperature [°C]') {
        // Single reads: the measured temperature, between Start Time and the '<>' grid.
        if (cells.length > 1 && i > lastStartRow) lastTemp = toNumber(cells[1].v);
      } else if (head === '<>') {
        i = readSingle(rows, i, cells[0].col, requireStart(i), lastTemp, lid, file, reads, warn);
      } else if (head === 'Cycle Nr.') {
        i = readKinetic(rows, i, requireStart(i), lid, file, reads, warn);
      }
    }
    if (!reads.length) throw new Error(file + ': no plate readings found (is this a Tecan Spark export?)');
    return { reads: reads, warnings: warnings };
  }

  /** '<>' header row, then rows A-H with 12 values in the next 12 columns. Returns the last row used. */
  function readSingle(rows, i, col0, start, temp, lid, file, reads, warn) {
    var grid = [], bad = [];
    for (var r = 0; r < N_ROWS; r++) {
      var row = rows[i + 1 + r] || [];
      var label = row[col0];
      if (typeof label !== 'string' || label.trim() !== ROWS[r]) {
        throw new Error(file + ': expected row ' + ROWS[r] + ' at sheet row ' + (i + 2 + r));
      }
      var vals = [];
      for (var c = 0; c < N_COLS; c++) {
        var x = toNumber(row[col0 + 1 + c]);
        if (isNaN(x)) bad.push(wellId(r, c));
        vals.push(x);
      }
      grid.push(vals);
    }
    if (bad.length) warn('non-numeric values in ' + bad.join(', ') + ' (read at ' + fmt(start) + ')');
    var read = { start: start, grid: grid, source: 'single', file: file };
    if (lid !== null) read.lid = lid;
    if (temp !== null && !isNaN(temp)) read.temp = temp;
    reads.push(read);
    return i + N_ROWS;
  }

  /** 'Cycle Nr.' header (Cycle Nr., Time [s], (Temp. [°C]), A1 ... H12) then one row per cycle. */
  function readKinetic(rows, i, blockStart, lid, file, reads, warn) {
    var hdr = rows[i];
    var col = { cycle: -1, time: -1, temp: -1, A1: -1 };
    for (var j = 0; j < hdr.length; j++) {
      var h = typeof hdr[j] === 'string' ? hdr[j].trim() : hdr[j];
      if (h === 'Cycle Nr.') col.cycle = j;
      else if (h === 'Time [s]') col.time = j;
      else if (h === 'Temp. [°C]') col.temp = j;
      else if (h === 'A1') col.A1 = j;
    }
    if (col.time < 0 || col.A1 < 0) throw new Error(file + ': kinetic header at row ' + (i + 1) + ' lacks Time [s] or A1');

    var k = i + 1;
    for (; k < rows.length; k++) {
      var cells = cellsOf(rows[k]);
      if (!cells.length || cells[0].v === 'End Time') break;
      var row = rows[k];

      var grid = [], nNum = 0, bad = [];
      for (var r = 0; r < N_ROWS; r++) {
        var vals = [];
        for (var c = 0; c < N_COLS; c++) {
          var raw = row[col.A1 + r * N_COLS + c];
          var x = toNumber(raw);
          if (!isNaN(x)) nNum++;
          else if (!isEmpty(raw)) bad.push(wellId(r, c));
          vals.push(x);
        }
        grid.push(vals);
      }
      if (nNum === 0) continue; // empty or "not executed" cycle
      if (nNum + bad.length < N_ROWS * N_COLS) warn('cycle row ' + (k + 1) + ' has missing well values');

      var secs = toNumber(row[col.time]);
      if (isNaN(secs)) throw new Error(file + ': unreadable Time [s] at row ' + (k + 1));
      var start = new Date(blockStart.getTime() + Math.round(secs * 1000));
      if (bad.length) warn('non-numeric values in ' + bad.join(', ') + ' (cycle at ' + fmt(start) + ')');

      var read = { start: start, grid: grid, source: 'kinetic', file: file };
      var cyc = col.cycle >= 0 ? toNumber(row[col.cycle]) : NaN;
      if (!isNaN(cyc)) read.cycle = cyc;
      if (lid !== null) read.lid = lid;
      var temp = col.temp >= 0 ? toNumber(row[col.temp]) : NaN;
      if (!isNaN(temp)) read.temp = temp;
      reads.push(read);
    }
    return k;
  }

  // ------------------------------------------------------------ workbook entry point
  /** All rows of the first worksheet, from A1, blank rows kept, raw cell values. */
  function sheetRows(XLSX, wb) {
    var ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) return [];
    var range = XLSX.utils.decode_range(ws['!ref']);
    range.s.r = 0; range.s.c = 0; // keep absolute row/column positions
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true, range: range });
  }

  /** Parse a Spark .xlsx file (ArrayBuffer / Uint8Array / Node Buffer). */
  function parseSpark(data, file) {
    var XLSX = getXLSX();
    var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    var wb = XLSX.read(bytes, { type: 'array', dense: true });
    return parseSparkRows(sheetRows(XLSX, wb), file);
  }

  // ------------------------------------------------------------ pasted grid
  /**
   * Parse 8 lines x 12 numbers separated by tabs, commas, semicolons or spaces.
   * Tolerates a header line of 1..12 (optionally led by '<>') and a leading A-H label per row.
   * opts: { start: Date (required; from the user's time label), file?: string }.
   */
  function parsePasted(text, opts) {
    opts = opts || {};
    if (!(opts.start instanceof Date) || isNaN(opts.start.getTime())) {
      throw new Error('Pasted grid needs a time');
    }
    var lines = String(text).split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== ''; })
      .map(function (l) { return l.split(/[\t,; ]+/).filter(function (t) { return t !== ''; }); });

    if (lines.length && lines[0].join(' ').replace(/^<>\s*/, '') === '1 2 3 4 5 6 7 8 9 10 11 12') lines.shift();
    if (lines.length !== N_ROWS) throw new Error('Pasted grid must have 8 rows (A-H); found ' + lines.length);

    var grid = lines.map(function (toks, r) {
      if (toks.length === N_COLS + 1 && toks[0].toUpperCase() === ROWS[r]) toks = toks.slice(1);
      if (toks.length !== N_COLS) {
        throw new Error('Pasted row ' + ROWS[r] + ' must have 12 numbers; found ' + toks.length);
      }
      return toks.map(function (t, c) {
        var x = Number(t);
        if (!isFinite(x)) throw new Error('Pasted value "' + t + '" in ' + wellId(r, c) + ' is not a number');
        return x;
      });
    });
    return { start: opts.start, grid: grid, source: 'pasted', file: opts.file || 'pasted' };
  }

  // ------------------------------------------------------------ timing helpers (SPEC section 5)
  /** Reads sorted by start time (stable; returns a new array). */
  function sortReads(reads) {
    return reads.slice().sort(function (a, b) { return a.start - b.start; });
  }

  /** Hours from t0 to read, unrounded. Display to 1 decimal place. */
  function hoursSince(t0, read) {
    return (read.start - t0.start) / 3600000;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  return {
    parseSpark: parseSpark,
    parseSparkRows: parseSparkRows,
    parsePasted: parsePasted,
    parseTimestamp: parseTimestamp,
    sortReads: sortReads,
    hoursSince: hoursSince,
    formatTimestamp: fmt,
    wellId: wellId,
  };
});

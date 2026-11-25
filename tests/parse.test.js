// Build step 2: parse.js (SPEC section 4).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../js/parse.js');

const FIX = path.join(__dirname, 'fixtures');
const D1104 = '1104 data';
const D1109 = 'cf&clz or pcc 20261109 to 1111';
const hasFixtures = fs.existsSync(path.join(FIX, D1104));
const fx = { skip: hasFixtures ? false : 'tests/fixtures/ not present (raw data are git-ignored)' };

function load(rel) {
  return P.parseSpark(fs.readFileSync(path.join(FIX, rel)), path.basename(rel));
}
function ts(d) { return P.formatTimestamp(d); }

// ---------------------------------------------------------------- SPEC section 4 unit tests
// ---------------------------------------------------------------- agreement with the oracle
const ORACLE = path.join(FIX, 'oracle_parse.json');
test('every fixture parses identically to reference_analysis.py', {
  skip: fs.existsSync(ORACLE) ? false : 'run: .venv/bin/python tests/oracle_dump.py',
}, () => {
  const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
  assert.equal(Object.keys(oracle).length, 18);
  for (const [rel, want] of Object.entries(oracle)) {
    const got = load(rel).reads;
    assert.equal(got.length, want.length, `${rel}: read count`);
    want.forEach((w, k) => {
      const g = got[k];
      // Oracle has microseconds; JS Dates have milliseconds.
      const [, y, mo, d, hh, mm, ss, us] = /(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)\.(\d+)/.exec(w.start).map(Number);
      const wantMs = new Date(y, mo - 1, d, hh, mm, ss).getTime() + us / 1000;
      assert.ok(Math.abs(g.start.getTime() - wantMs) <= 1, `${rel} #${k}: start ${ts(g.start)} vs ${w.start}`);
      assert.equal(g.source, w.source, `${rel} #${k}: source`);
      assert.deepEqual(g.grid, w.grid, `${rel} #${k}: grid`);
    });
  }
});

// ---------------------------------------------------------------- synthetic edge cases
const grid8x12 = (f) => Array.from({ length: 8 }, (_, r) => Array.from({ length: 12 }, (_, c) => f(r, c)));
const HDR = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12'];
const wellHdr = 'ABCDEFGH'.split('').flatMap((R) => HDR.map((h) => R + h.slice(1)));

test('kinetic header without Temp column: A1 is located by name', () => {
  const vals = grid8x12((r, c) => r * 12 + c).flat();
  const rows = [
    ['Start Time', null, null, null, '2026-01-01 00:00:00'],
    ['Cycle Nr.', 'Time [s]', ...wellHdr],
    ['1', 0, ...vals],
    ['2', 60, ...vals],
    ['3', 120], // not executed: no well values -> skipped
    [],
    ['End Time', null, null, null, '2026-01-01 00:03:00'],
  ];
  const { reads } = P.parseSparkRows(rows, 'x');
  assert.equal(reads.length, 2);
  assert.equal(reads[1].start - reads[0].start, 60000);
  assert.equal(reads[0].grid[1][0], 12); // B1
  assert.equal(reads[0].temp, undefined);
});

test('non-numeric well values become NaN with a warning', () => {
  const rows = [
    ['Start Time', null, '2026-01-01 00:00:00'],
    ['<>', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    ...'ABCDEFGH'.split('').map((R, r) => [R, ...grid8x12(() => 0.1)[r]]),
  ];
  rows[2][5] = 'OVER'; // A5
  const { reads, warnings } = P.parseSparkRows(rows, 'x');
  assert.ok(Number.isNaN(reads[0].grid[0][4]));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /A5/);
});

test('errors: no readings, or a data block with no Start Time', () => {
  assert.throws(() => P.parseSparkRows([['hello']], 'x'), /no plate readings/);
  assert.throws(() => P.parseSparkRows([['<>']], 'x'), /no Start Time/);
});

// ---------------------------------------------------------------- pasted grid
test('pasted grid: tabs, commas or spaces; optional header row and row letters', () => {
  const start = new Date(2026, 0, 1);
  const g = grid8x12((r, c) => +(0.1 + r / 10 + c / 100).toFixed(2));
  const tsv = g.map((row) => row.join('\t')).join('\n');
  const csv = g.map((row) => row.join(',')).join('\r\n');
  const labelled = '<>\t1\t2\t3\t4\t5\t6\t7\t8\t9\t10\t11\t12\n' +
    g.map((row, r) => 'ABCDEFGH'[r] + '  ' + row.join(' ')).join('\n') + '\n\n';
  for (const text of [tsv, csv, labelled]) {
    const read = P.parsePasted(text, { start });
    assert.deepEqual(read.grid, g);
    assert.equal(read.source, 'pasted');
    assert.equal(read.start, start);
  }
});

test('pasted grid: wrong shape, bad numbers and missing time are rejected', () => {
  const start = new Date(2026, 0, 1);
  const row = Array(12).fill('0.1').join('\t');
  assert.throws(() => P.parsePasted(Array(7).fill(row).join('\n'), { start }), /8 rows/);
  assert.throws(() => P.parsePasted(Array(8).fill(row + '\t0.2').join('\n'), { start }), /12 numbers/);
  assert.throws(() => P.parsePasted(Array(8).fill(row.replace('0.1', 'x')).join('\n'), { start }), /not a number/);
  assert.throws(() => P.parsePasted(Array(8).fill(row).join('\n'), {}), /needs a time/);
});

test('sortReads orders by start and does not mutate', () => {
  const a = { start: new Date(2026, 0, 2) }, b = { start: new Date(2026, 0, 1) };
  const input = [a, b];
  assert.deepEqual(P.sortReads(input), [b, a]);
  assert.deepEqual(input, [a, b]);
});

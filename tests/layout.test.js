// Build step 3: layout.js presets, lookup and validation (SPEC section 6).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/layout.js');

const col = (layout, c) => 'ABCDEFGH'.split('').map((R) => L.roleOf(layout, R + c));

test('preset 1104 – 8×8 matches SPEC 6.1 exactly', () => {
  const p = L.getPreset('p1104-8x8');
  assert.deepEqual([p.nRows, p.nCols], [8, 8]);
  assert.deepEqual(p.A, [0, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2]);
  assert.deepEqual(p.B, [0, 1.5625, 3.125, 6.25, 12.5, 25, 50, 100]);
  assert.deepEqual(p.pair, { A: { name: 'CF', unit: 'µg/mL' }, B: { name: 'CLZ', unit: 'µM' } });
  assert.equal(L.roleOf(p, 'A1'), 'drugfree');
  assert.equal(L.roleOf(p, 'H8'), 'matrix');
  assert.deepEqual(col(p, 9), Array(8).fill('cellfree'));
  assert.deepEqual(col(p, 10), Array(8).fill('solventfree'));
  assert.deepEqual(col(p, 11), Array(8).fill('sterile'));
  assert.deepEqual(col(p, 12), Array(8).fill('sterile'));
  for (let r = 0; r < 8; r++) assert.equal(L.cellfreeForRow(p, r), 'ABCDEFGH'[r] + '9');
  assert.deepEqual(L.validate(p, { useDrift: true }), []);
});

test('presets 1109 – 10×8 (CLZ and PCC) match SPEC 6.1 exactly', () => {
  const CF10 = [0, 0.0078125, 0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2];
  const want = {
    'p1109-10x8-clz': [0, 0.390625, 0.78125, 1.5625, 3.125, 6.25, 12.5, 25],
    'p1109-10x8-pcc': [0, 0.1875, 0.375, 0.75, 1.5, 3, 6, 12],
  };
  for (const [id, B] of Object.entries(want)) {
    const p = L.getPreset(id);
    assert.deepEqual([p.nRows, p.nCols], [8, 10], id);
    assert.deepEqual(p.A, CF10, id);
    assert.deepEqual(p.B, B, id);
    assert.equal(L.roleOf(p, 'A1'), 'drugfree');
    assert.equal(L.roleOf(p, 'H10'), 'matrix');
    assert.deepEqual(col(p, 11), Array(8).fill('cellfree'), id);
    assert.deepEqual(col(p, 12), [...Array(4).fill('solventfree'), ...Array(4).fill('sterile')], id);
    assert.deepEqual(L.validate(p, { useDrift: true }), [], id);
  }
  assert.equal(L.getPreset('p1109-10x8-pcc').pair.B.name, 'PCC');
});

test('presets are frozen; clone() gives an editable copy', () => {
  const p = L.getPreset('p1104-8x8');
  assert.throws(() => { p.A[1] = 99; }, TypeError);
  const q = L.clone(p);
  q.A[1] = 99;
  assert.equal(p.A[1], 0.03125);
});

test('well ids and matrix lookup', () => {
  assert.equal(L.wellId(7, 11), 'H12');
  assert.deepEqual(L.parseWellId('h12'), { row: 7, col: 11 });
  assert.equal(L.parseWellId('I1'), null);
  assert.equal(L.parseWellId('A13'), null);
  const p = L.getPreset('p1109-10x8-clz');
  assert.equal(L.matrixWellId(p, 2, 3), 'C4'); // B index 2, A index 3
  assert.deepEqual(L.matrixIndex(p, 2, 3), { r: 2, c: 3 });
  assert.equal(L.matrixIndex(p, 0, 10), null);
});

test('validation catches the SPEC 6.2 errors', () => {
  const base = () => L.clone(L.getPreset('p1104-8x8'));

  let l = base(); delete l.roles.A1;
  assert.match(L.validate(l).join(' '), /exactly one drug-free/);

  l = base(); l.roles.A12 = 'drugfree';
  assert.match(L.validate(l).join(' '), /exactly one drug-free/);

  l = base(); l.A = [0, 0.1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  assert.match(L.validate(l).join(' '), /strictly increasing/);

  l = base(); l.B[0] = 0.5;
  assert.match(L.validate(l).join(' '), /first concentration must be 0/);

  l = base(); l.A = l.A.slice(0, 7);
  assert.match(L.validate(l).join(' '), /needs 8 concentrations/);

  l = base(); delete l.roles.C9; delete l.cellfreeByRow[2];
  assert.deepEqual(L.validate(l, { useDrift: false }), []);
  assert.match(L.validate(l, { useDrift: true }).join(' '), /missing: C/);

  l = base(); l.roles.B2 = 'sterile';
  assert.match(L.validate(l).join(' '), /inside the matrix/);
});

// ---------------------------------------------------------------- editor model (build step 9)
test('concSeries reproduces the preset concentration lists exactly', () => {
  assert.deepEqual(L.concSeries(2, 2, 7), L.getPreset('p1104-8x8').A);
  assert.deepEqual(L.concSeries(100, 2, 7), L.getPreset('p1104-8x8').B);
  assert.deepEqual(L.concSeries(2, 2, 9), L.getPreset('p1109-10x8-clz').A);
  assert.deepEqual(L.concSeries(25, 2, 7), L.getPreset('p1109-10x8-clz').B);
  assert.deepEqual(L.concSeries(12, 2, 7), L.getPreset('p1109-10x8-pcc').B);
  assert.deepEqual(L.concSeries(9, 3, 2), [0, 3, 9]);
  assert.throws(() => L.concSeries(0, 2, 3), /top concentration/);
  assert.throws(() => L.concSeries(1, 1, 3), /dilution factor/);
  assert.throws(() => L.concSeries(1, 2, 2.5), /whole number/);
});

test('parseConcList: separators, leading 0 added, bad tokens rejected', () => {
  assert.deepEqual(L.parseConcList('0, 0.5; 1\n2  4'), [0, 0.5, 1, 2, 4]);
  assert.deepEqual(L.parseConcList('0.5 1 2'), [0, 0.5, 1, 2]);
  assert.throws(() => L.parseConcList('1, two'), /not a number/);
  assert.throws(() => L.parseConcList('  '), /at least one/);
});

test('buildLayout rebuilds the 1109 CLZ preset from editor input', () => {
  const p = L.getPreset('p1109-10x8-clz');
  const roles = {};
  for (const [id, role] of Object.entries(p.roles)) roles[id] = role;
  const { layout, errors } = L.buildLayout({ id: 'x', name: 'copy', A: p.A, B: p.B, pair: p.pair, roles }, { useDrift: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(layout.matrixOrigin, { row: 0, col: 0 });
  assert.deepEqual([layout.nRows, layout.nCols], [8, 10]);
  assert.deepEqual(layout.cellfreeByRow, p.cellfreeByRow);
});

test('buildLayout: the drug-free well sets the matrix origin; matrix may be smaller than the plate', () => {
  // 4x4 matrix starting at C3; cell-free in column 9 for rows C-F
  const roles = { C3: 'drugfree', C9: 'cellfree', D9: 'cellfree', E9: 'cellfree', F9: 'cellfree', A1: 'sterile', B1: 'unused' };
  const { layout, errors } = L.buildLayout({ id: 'y', name: 'small', A: [0, 1, 2, 4], B: [0, 1, 2, 4],
    pair: { A: { name: 'X', unit: 'µM' }, B: { name: 'Y', unit: 'µM' } }, roles }, { useDrift: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(layout.matrixOrigin, { row: 2, col: 2 });
  assert.equal(L.matrixWellId(layout, 3, 3), 'F6');
  assert.equal(L.roleOf(layout, 'B1'), 'unused');
  assert.equal(layout.roles.B1, undefined); // 'unused' is not stored
  assert.equal(L.cellfreeForRow(layout, 4), 'E9');
});

test('buildLayout reports editor errors', () => {
  const pair = { A: { name: 'X', unit: '' }, B: { name: '', unit: '' } };
  const base = { id: 'z', name: 'bad', A: [0, 1, 2], B: [0, 1, 2], pair };
  let r = L.buildLayout(Object.assign({}, base, { roles: { A9: 'cellfree' } }), { useDrift: true });
  const all = r.errors.join(' ');
  assert.match(all, /Drug B needs a name/);
  assert.match(all, /exactly one drug-free well \(found 0\)/);
  assert.match(all, /missing: B, C/);
  r = L.buildLayout(Object.assign({}, base, { roles: { A1: 'drugfree', A9: 'cellfree', A10: 'cellfree' } }));
  assert.match(r.errors.join(' '), /Row A has more than one cell-free well/);
  r = L.buildLayout(Object.assign({}, base, { roles: { G11: 'drugfree' } }));
  assert.match(r.errors.join(' '), /does not fit/);
});

test('fromJSON accepts a stored layout and rejects malformed ones', () => {
  const stored = JSON.parse(JSON.stringify(L.getPreset('p1104-8x8')));
  stored.id = 'custom-1';
  const l = L.fromJSON(stored);
  assert.deepEqual(L.validate(l, { useDrift: true }), []);
  assert.throws(() => L.fromJSON({ id: 'q', A: [0, 'x'], B: [0, 1], roles: {} }), /list of numbers/);
  assert.throws(() => L.fromJSON({ id: 'q', A: [0, 1], B: [0, 1] }), /no roles/);
  assert.throws(() => L.fromJSON({ id: 'q', A: [0, 1], B: [0, 1], roles: {} }), /drug-free/);
});

// Shared test helpers: fixture loading and the oracle's section 9 cases.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const P = require('../js/parse.js');
const L = require('../js/layout.js');
const C = require('../js/correct.js');

const FIX = path.join(__dirname, 'fixtures');
const ORACLE_CASES = path.join(FIX, 'oracle_cases.json');

const fixturesSkip = fs.existsSync(path.join(FIX, '1104 data'))
  ? false : 'tests/fixtures/ not present (raw data are git-ignored)';
const oracleSkip = fs.existsSync(ORACLE_CASES)
  ? false : 'run: .venv/bin/python tests/oracle_dump.py';

function loadReads(rel) {
  return P.parseSpark(fs.readFileSync(path.join(FIX, rel)), path.basename(rel)).reads;
}

/** Oracle cases, each with t0/tx reads parsed by our code and the correction run under default settings. */
function oracleCases(settings) {
  if (oracleSkip) return [];
  return JSON.parse(fs.readFileSync(ORACLE_CASES, 'utf8')).map((oc) => {
    const t0 = loadReads(oc.t0File)[0];
    const tx = loadReads(oc.txFile)[0];
    const layout = L.getPreset(oc.layout);
    const corr = C.correct({ t0: t0.grid, tx: tx.grid, layout, settings });
    return { oc, t0, tx, layout, corr };
  });
}

function assertClose(assert, got, want, tol, msg) {
  assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} (±${tol})`);
}

function assertMatrixClose(assert, got, want, tol, msg) {
  assert.equal(got.length, want.length, `${msg}: rows`);
  want.forEach((row, r) => {
    assert.equal(got[r].length, row.length, `${msg}: cols in row ${r}`);
    row.forEach((w, c) => assertClose(assert, got[r][c], w, tol, `${msg} [${r}][${c}]`));
  });
}

module.exports = { FIX, fixturesSkip, oracleSkip, loadReads, oracleCases, assertClose, assertMatrixClose };

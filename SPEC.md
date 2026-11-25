# Checkerboard Analysis Tool: Build Specification (v1)

Owner: Imperial Bioengineering Y3 group project (antifungal synergy assay, Billerbeck lab).
Status: design agreed 2026-11-24. Build in Claude Code from this file.
Companion file: `reference_analysis.py`, a Python test oracle. If the web tool and the oracle disagree on the test data, the web tool is wrong until proven otherwise.

---

## 1. Purpose and scope

A browser-based tool that takes **raw Tecan Spark plate-reader exports** from two-drug broth-microdilution checkerboard assays. It lets the user choose an analysis method and returns corrected growth, interaction metrics, robustness checks, figures and exports.

**In v1**
- Spark .xlsx import (single reads and kinetic runs) plus a paste-a-grid fallback.
- Multiple plates per session; layout presets and a layout editor.
- Background correction: initial-read subtraction plus per-row cell-free drift subtraction.
- Methods: **MIC + FICI** (adjustable inhibition cut-off), **Bliss excess**, **HSA excess**.
- Robustness panel, repeat pooling, CSV/PNG/SVG export, session export/import.

**Not in v1, but the architecture must allow adding them as plug-in methods (section 3.2):**
growth curves and AUC from kinetic runs; Loewe additivity; ZIP; a shared group database.

**Non-goals:** user accounts, servers, uploading data anywhere.

---

## 2. Hosting and data handling

- Static site on **GitHub Pages**, served from a group repository. No backend.
- All files are processed **in the viewer's browser**. Nothing is uploaded and nothing persists after the tab closes, except:
  - custom layout presets in `localStorage` (wrapped in try/catch; the tool must work without it);
  - files the user explicitly downloads (exports and the session JSON).
- **Raw assay data are unpublished lab data.** Do not commit them to a public repository. Either:
  - (a) keep the repository public for the code and put the test fixtures in a git-ignored `tests/fixtures/`; or
  - (b) make the repository private. GitHub Pages from a private repo needs a paid plan, which the GitHub Student Developer Pack may cover; check this.

  Ask the supervisor before putting any data online.

---

## 3. Architecture

```
index.html          UI only (layout, controls, rendering). No maths.
css/style.css
js/parse.js         Tecan Spark + pasted-grid parsing -> Read objects
js/layout.js        Layout presets, editor model, well-role lookup
js/correct.js       Background correction + growth fraction
js/methods/fici.js  MIC + FICI + robustness
js/methods/bliss.js Bliss excess
js/methods/hsa.js   HSA excess
js/methods/index.js Method registry
js/pool.js          Repeat grouping and pooled summaries
js/export.js        CSV / SVG / PNG / session JSON
js/vendor/xlsx.full.min.js  SheetJS, pinned exact version, vendored (no CDN at runtime)
tests/*.test.js     node --test
tests/fixtures/     raw .xlsx files (git-ignored if the repo is public)
```

- **No framework, no build step.** Plain ES2020 scripts.
- `parse.js`, `layout.js`, `correct.js`, `methods/*`, `pool.js` must be **pure** (no DOM access). They must run under Node for tests. Use a small UMD-style wrapper so the same file works as a browser `<script>` (attaching to `window.CB`) and as `require()` in Node. Do not use ES `import`, because pages opened from `file://` block module imports.
- Vendor SheetJS into `js/vendor/` rather than loading it from a CDN, so the tool works offline and the version never drifts.

### 3.1 Core data types

```js
Read   = { start: Date, grid: number[8][12], source: 'single'|'kinetic'|'pasted', file: string, cycle?: number }
Plate  = { id, name, pair: {A:{name,unit}, B:{name,unit}}, layoutId, reads: Read[], t0Index, analysisReadIndex }
Layout = { id, name, nRows, nCols,                       // matrix size (B along rows, A along columns)
           matrixOrigin: {row:0, col:0},                  // top-left matrix well; [0,0] = drug-free
           A: number[], B: number[],                      // concentrations incl. leading 0
           roles: { [wellId]: 'drugfree'|'cellfree'|'solventfree'|'sterile'|'unused' },
           cellfreeByRow?: { [row]: wellId } }            // per-row no-cell wells
Settings = { cutoff: 0.95, useT0: true, useDrift: true, reference: 'drugfree'|'solventfreeMean' }
```

### 3.2 Method registry (the extension point)

Every analysis is a module exposing:

```js
{
  id: 'fici',                         // unique
  label: 'MIC + FICI',
  requires: ['endpoint'],             // or ['kinetic'] for future growth-curve methods
  defaults: { cutoff: 0.95 },         // method-specific settings, rendered as controls
  run(ctx) -> Result,                 // pure; ctx = { frac, A, B, settings, plate, allReadsFrac }
  pool(results[]) -> PooledResult,    // optional; used by repeat grouping
  render(el, result),                 // UI-side; lives in index.html's script, keyed by id
  toCSV(result) -> string
}
```

- The UI lists every registered method as a checkbox.
- Adding growth curves, Loewe or ZIP later should mean adding one module and its renderer, with no change elsewhere.

---

## 4. Input parsing (Tecan SparkControl exports)

Read only the first worksheet ("Result sheet"). Iterate over rows. Many metadata values sit in a later cell of the row, not the second cell, so collect non-empty cells per row.

1. **Start Time:** a row whose first non-empty cell is `Start Time` gives a timestamp `YYYY-MM-DD HH:MM:SS` in the next non-empty cell. Track the most recent one; it applies to the block that follows.
2. **Single read:** a row whose first cell is `<>` is followed by column headers 1–12. The next 8 rows are A–H, with 12 numeric values in columns 2–13. One Read, `start` = the most recent Start Time.
3. **Kinetic block:** a row whose first cell is `Cycle Nr.` is a header: `Cycle Nr., Time [s], (Temp. [°C]), A1 … H12`. The Temp column is sometimes absent, so locate `A1` by name. Each following row until a blank or `End Time` row is one cycle: `start = blockStart + Time[s]`, and the grid is the 96 values from the `A1` column in row-major order (A1…A12, B1…). **Skip cycles with no well values.** This happens: a block that was "not executed" has an empty cycle row.
4. A file may contain **several kinetic blocks**. `cfclz continuous_…xlsx` has two (0–24 h at 30-min intervals, then a further 4 h). Return all of them.
5. Record `Lid lifter` (Lid / No lid) and the temperature per read for display only.
6. **Pasted grid fallback:** a textarea accepting 8 lines × 12 numbers (tabs, commas or spaces). The user supplies its time label.

Unit tests: the expected read counts, timestamps and well values for the fixture files are kept with the fixtures (see section 9).

---

## 5. Plates and timing

- The user creates a plate, drops in all of its files, and picks a layout and the drug-pair names.
- Sort all reads by `start`. **t0 = the earliest read** by default. Each read is labelled **hours since t0**, to 1 decimal place.
- Never derive times from filenames: the hour in a filename is hand-typed and can be wrong.
- The user can override the t0 read and choose the **analysis read**, which defaults to the latest.
- Several plates can be open at once and are listed in a sidebar.

---

## 6. Layouts

### 6.1 Presets (exact)

**Preset "1104 – 8×8"** (CF + CLZ, 2026-11-04)
- Matrix: rows A–H × columns 1–8. Drug A (columns) CF µg/mL: `0, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2`. Drug B (rows) CLZ µM: `0, 1.5625, 3.125, 6.25, 12.5, 25, 50, 100`.
- A1 = drug-free (full vehicle).
- Column 9, rows A–H = **cell-free** (drug, no cells), one per row.
- Column 10, rows A–H = **solvent-free** growth.
- Columns 11–12 = **sterile medium**.

**Preset "1109 – 10×8"** (CF + CLZ or CF + PCC, 2026-11-09)
- Matrix: rows A–H × columns 1–10. Drug A CF µg/mL: `0, 0.0078125, 0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2`.
- Drug B, per pair:
  - CLZ µM: `0, 0.390625, 0.78125, 1.5625, 3.125, 6.25, 12.5, 25`;
  - PCC µM: `0, 0.1875, 0.375, 0.75, 1.5, 3, 6, 12`.
- A1 = drug-free.
- Column 11, rows A–H = **cell-free** (drug, no cells).
- Column 12, rows A–D = **solvent-free**; rows E–H = **sterile YPD**.

### 6.2 Editor
- Set the matrix size, the orientation (which drug runs along the columns), drug names and units, and the concentrations: top concentration + dilution factor + number of steps, or a typed list. The first concentration is always 0.
- Click wells on a 96-well map to assign roles. Show a legend.
- Save and load custom layouts in localStorage.
- Validate: exactly one drug-free well; every matrix row has a cell-free well if drift correction is on; the concentration lists are strictly increasing.

---

## 7. Correction and growth fraction

For the analysis read `x` and initial read `0`, per well:

```
dOD(well)          = OD_x(well) − OD_0(well)                 [if useT0]
drift(row)         = dOD(cell-free well of that row)
dOD_corr(well)     = dOD(well) − drift(row)                  [if useDrift]
ref                = dOD_corr(drug-free well)                [or mean over solvent-free wells]
g(well)            = dOD_corr(well) / ref                    (growth fraction; 1 = drug-free growth)
```

- Keep negative values in tables and exports; clip to 0 only for display.
- **Warnings** (shown in the plate's warnings box):
  - drift correction is on but the layout has no cell-free wells, so that step is skipped;
  - the drug-free reference and the solvent-free mean differ by more than 15%;
  - cell-free drift is above 2% of `ref` in any row (show the per-row values; at a 95% cut-off this matters);
  - **colour stability:** in the highest-concentration matrix wells with g ≤ 0.05, report OD_x − OD_0 relative to OD_0. This is informational.

---

## 8. Methods

All methods take the matrix of growth fractions `g[r][c]`, where r indexes B (rows) and c indexes A (columns). `[0][0]` is drug-free, row 0 is A alone and column 0 is B alone.

### 8.1 MIC + FICI
- **Inhibited:** `g ≤ 1 − cutoff`. The cut-off is a slider from 0.50 to 0.99, default 0.95. The Robbins et al. 2015 paper used 95% (as reported by the user; not checked here).
- **Single-agent MIC:** the lowest non-zero concentration i such that wells i…end along the drug-alone row/column are **all** inhibited. If none qualifies, MIC is **off-scale**: use `2 × top concentration` and flag every FICI that depends on it as a **bound**.
- **Boundary wells:** for each row r ≥ 1 with `B[r] < MIC_B`, scan c = 1… while `A[c] ≤ MIC_A`. The boundary well is the first c where wells c…end of that row are all inhibited. Rows with no such well contribute nothing.
- `FICI(well) = A[c]/MIC_A + B[r]/MIC_B`.
- **FICImin** and **FICImax** = min and max over the boundary wells. Report the wells that give them.
- **Odds (2003) classification:** FICI ≤ 0.5 synergy; 0.5 < FICI ≤ 4 indifference; FICI > 4 antagonism. Always state that FICI ≈ 1 cannot distinguish additivity from indifference under these cut-offs.
- **Robustness panel** (always shown):
  1. **Attainable floor** = `A[1]/MIC_A + B[1]/MIC_B`. If it is above 0.5, say: "This plate cannot detect synergy at this cut-off; lower the concentration ranges."
  2. **Cut-off sensitivity:** a table of MIC_A, MIC_B, FICImin and class at 50, 80, 90 and 95% (plus the current slider value).
  3. **Time sensitivity:** the same table across every read (single reads; for kinetic runs, hourly cycles only).
  4. **Near-cut-off wells:** any well with `|g − (1 − cutoff)| ≤ 0.02`, listed with its % growth. These can flip an MIC.
  5. **Dilution error:** FICImin recomputed with MIC_A and MIC_B each moved ±1 dilution (4 combinations). Show the range.
  6. Banner when n = 1: "Single plate; this is one observation, not a demonstrated interaction."

### 8.2 Bliss excess
```
E      = 1 − clip(g, 0, 1)                 (fractional inhibition)
E_A    = E[0][c],  E_B = E[r][0]
E_exp  = E_A + E_B − E_A·E_B
excess = E[r][c] − E_exp                   for r ≥ 1, c ≥ 1
```
- Show a diverging heatmap of `excess` in percentage points, with a neutral grey at 0 (positive = more inhibition than expected).
- **Summary:** the mean excess over all combination wells, and the **max over all 3×3 windows** of the windowed mean.
- **No synergy threshold.** Display: "Bliss has no agreed cut-off; FICI and Bliss can disagree on the same data."

### 8.3 HSA excess
Same as 8.2 with `E_exp = max(E_A, E_B)`.

---

## 9. Acceptance tests (must pass before UI work is considered done)

Settings: cutoff 0.95, useT0 on, useDrift on, reference = drug-free well. Tolerance ±0.001 on FICI and ±0.05 percentage points on Bliss/HSA. Fixtures are the raw files in `tests/fixtures/`, with the same folder names as the data folder.

**The expected values are unpublished lab results and are not in this public repository** (supervisor decision, 2026-11-24). They live with the raw data in the git-ignored `tests/fixtures/`:
- `tests/fixtures/acceptance/section9.test.js`: the acceptance tests themselves (run by `npm test` when present);
- `tests/fixtures/SPEC_full.md`: this specification with the full section 9 table.

The cases cover three plates (1109 CF+CLZ, 1109 CF+PCC, 1104 CF+CLZ) and check, for each: MIC_A and MIC_B (with the off-scale bound flag), FICImin and FICImax with their wells, the class, the number of boundary wells, the attainable floor, near-cut-off wells, per-row drift warnings, and Bliss/HSA mean and max 3×3. The robustness panel must make any class change across cut-offs visible, and the tests check that it does.

Run the oracle: `python3 reference_analysis.py <data_dir>`.

---

## 10. Repeats (pooling)

- Plates are grouped automatically when the **drug pair and the A/B concentration lists match**. The user can override the grouping.
- Group view: one row per plate (date, read time, MICs, FICImin/max, class, Bliss/HSA summaries), then a pooled row:
  - **FICI:** median FICImin, range, n, and a consistency count such as "synergy on 2 of 3 plates". The class is taken from the median.
  - **Bliss/HSA:** mean ± SD of the per-plate summary scores. Average the excess heatmaps well by well only when the concentrations are identical.
- Always show n. With n < 3, show "Fewer than 3 independent repeats."

---

## 11. Interface

- **Sidebar:** the plate list (add, rename, duplicate, delete) and the repeat groups.
- **Plate view, top to bottom:**
  1. files and reads table (file, time since t0, source, lid, temperature; t0 and analysis-read selectors);
  2. layout picker or editor with the 96-well role map;
  3. correction settings and the reference choice;
  4. method checkboxes;
  5. one results card per method: heatmap(s), summary numbers, robustness panel (FICI), warnings;
  6. export buttons.
- **Heatmaps:** SVG drawn at real pixel size. Axes show concentrations with units, and each cell shows its value.
  - FICI: % growth with a single sequential hue (light to dark), the inhibition boundary outlined, and the FICImin well boxed.
  - Bliss/HSA: a diverging two-hue scale with neutral grey at 0.
  - Hovering over a well shows its id, both concentrations, raw OD at t0 and tx, corrected dOD, % growth and FICI.
- **Accessibility:** colour is never the only signal (values are printed); visible focus; keyboard-operable controls.
- Works in a 720 px-wide pane and on a phone (stacked).

---

## 12. Export and session

- **Per plate:**
  - `*_growth.csv`: well, row, col, conc A, conc B, role, OD t0, OD tx, dOD, drift, dOD_corr, growth fraction;
  - `*_results.csv`: method, metric, value, bound flag, settings;
  - each heatmap as **SVG** and **PNG** (render the SVG to a canvas at 2× scale).
- **Group:** `*_pooled.csv`.
- **Session JSON** (Export / Import):
  ```json
  {"schema":"checkerboard-session/1","exported":"ISO time","settings":{},"layouts":[],
   "plates":[{"id":"","name":"","pair":{},"layoutId":"","t0Index":0,"analysisReadIndex":0,
              "reads":[{"start":"ISO","source":"single","file":"","grid":[[...12],...8]}]}]}
  ```
  Import validates the schema and the grid shape, then rebuilds the plates. Raw reads are stored, not derived values, so results always recompute under the current code.
- Use standard downloads: create a Blob, then click an `a[download]`. GitHub Pages allows this.

---

## 13. Build order

1. Repository skeleton, vendored SheetJS, the UMD wrapper, and `node --test` running.
2. `parse.js` plus the parse tests (section 4).
3. `layout.js` with the two presets; `correct.js`.
4. `methods/fici.js` and **all section 9 FICI assertions passing**.
5. `methods/bliss.js` and `methods/hsa.js` and their assertions.
6. A minimal UI: drop files, choose a preset, show the FICI heatmap and numbers. Check against the oracle by eye.
7. Robustness panel, warnings, Bliss/HSA cards.
8. Multiple plates, repeat pooling.
9. Layout editor, paste-grid input.
10. Exports and the session JSON.
11. GitHub Pages deployment and a README with a "how to use" section.

After every step, run the tests. Do not start the UI until steps 2–5 pass.

---

## 14. Decisions log (agreed 2026-11-24)

1. Input: Spark .xlsx (single and kinetic) plus paste-grid fallback.
2. Plates are assembled from files using internal Start Times; earliest = t0; user can override.
3. Multiple plates per session.
4. Layouts: presets plus a click-to-assign editor; custom presets saved in the browser.
5. Correction: initial-read and per-row cell-free drift subtraction, both on by default and toggleable; warning if no cell-free wells.
6. Reference: the drug-free well by default; solvent-free mean optional; warning above 15% difference.
7. Analyse the chosen read (default latest), plus a time-robustness table.
8. FICI rules as in 8.1.
9. Bliss and HSA as in 8.2 and 8.3, with no thresholds.
10. Exports: CSV, SVG, PNG.
11. Data stay in the browser; export and download available; session JSON.
12. Repeat pooling: median/range/n plus a consistency count; Bliss/HSA mean ± SD.
13. Session export/import.
14. Code: plain JS, separate pure maths modules, Node tests, vendored SheetJS.
15. Acceptance tests from section 9.
16. Hosting: GitHub Pages.
17. This spec is the handover.
18. Section 9 expected values are kept out of the public repository with the raw data (supervisor, 2026-11-24).

Planned later (as registry modules): growth curves and AUC (kinetic), Loewe, ZIP, shared group storage.

# Checkerboard Analysis

A browser tool for two-drug broth-microdilution checkerboard assays read on a Tecan Spark plate reader. Drop in the raw SparkControl `.xlsx` exports and it gives you corrected growth, MIC + FICI (with robustness checks), Bliss excess and HSA excess. You also get heatmaps, pooled repeats, and CSV, SVG and PNG exports.

**Your data stay on your computer.** The page runs entirely in your browser tab. Nothing is uploaded, and nothing is kept after you close the tab except:
- custom layouts you save (stored in this browser);
- files you choose to download.

Built for the Billerbeck lab antifungal synergy project (Imperial Bioengineering, Y3 group project). The full design is in [SPEC.md](SPEC.md).

---

## How to use

### 1. Open the tool
Open the GitHub Pages link for this repository. To use it offline, download the repository and open `index.html` directly. No install or internet connection is needed.

### 2. Add a plate and its files
1. A plate called *Plate 1* is ready when you open the page. Use **+ Add plate** in the sidebar for more, and rename a plate with the name box at the top.
2. Drop **every** Spark export for that plate onto the drop zone, including the initial (t0) read. You can drop single reads and kinetic runs together. A kinetic file becomes one read per cycle.
3. Check the reads table:
   - Times are measured from the **Start Time inside each file**, never from the filename. The hour in a filename is typed by hand and can be off.
   - **t0** defaults to the earliest read, and **Analyse** defaults to the latest. Change either with the radio buttons.

If you don't have the `.xlsx` file, open **Paste a grid instead**:
- Paste 8 rows × 12 OD values. A block copied from Excel, including its headers, works.
- Say when the read was taken, then click **Add pasted read**. The first read on a plate needs a date and time. Later reads can be given as hours after it.

### 3. Choose the layout
1. Pick a **Preset**:
   - `1104 – 8×8` is CF + CLZ;
   - `1109 – 10×8` comes in a CLZ version and a PCC version.
2. Type the drug names if they differ.
3. If your plate is laid out differently, click **New layout** or **Edit a copy**:
   - Set the matrix size, which drug runs along the columns, and the concentrations (top + dilution factor + steps, or a typed list).
   - Click wells to set their roles: drug-free, cell-free, solvent-free, sterile medium.
   - Save. The layout is stored in this browser only, so to move it to another computer use a session file (step 7).

The editor will not save a layout that lacks exactly one drug-free well, or one with concentrations that do not increase. With drift correction on, every matrix row also needs a cell-free well.

### 4. Check the correction settings
These apply to every plate.
- **Subtract the t0 read**: on by default.
- **Subtract per-row cell-free drift**: on by default. Without cell-free wells, the step is skipped and you get a warning.
- **Reference**: the drug-free well by default, or the mean of the solvent-free wells. You are warned if the two differ by more than 15%.

### 5. Read the results
Each method has a card. **Read the warnings box first.** It flags:
- cell-free drift above 2% of the reference;
- a reference mismatch;
- colour-stability notes.

**MIC + FICI**
- Use the slider to set the inhibition cut-off (95% by default).
- The heatmap shows % growth. The inhibited region is outlined and the FICImin well is boxed. Hover over or focus a well for its raw ODs, corrected change, % growth and FICI.
- The **robustness panel** shows how the result moves when you change:
  - the cut-off (90 / 95% and others);
  - the read time;
  - the MIC by ±1 dilution.

  It also lists **near-cut-off wells**. If the class changes across the panel, the result is **not robust**: report it as unresolved, not as synergy.
- A MIC marked **(bound)** means nothing in that row or column reached the cut-off. The true MIC is above the highest concentration, so the FICI built from it is a bound too.

**Bliss excess and HSA excess**
- These are diverging heatmaps of observed minus expected inhibition, in percentage points. Positive means more inhibition than expected; grey is 0.
- Each card gives the mean excess and the best 3×3 window.
- No synergy thresholds are applied.

### 6. Pool repeats
- Plates with the same drug pair and the same concentration lists group automatically under **Repeat groups** in the sidebar. To group plates by hand, type the same label into **Repeat group** on each of them.
- Click a group to see one row per plate plus a pooled row:
  - FICI: median FICImin, range, n, and how many plates gave each class;
  - Bliss/HSA: mean ± SD.
- With fewer than 3 plates, the tool says so. Treat the result as preliminary.

### 7. Export and save
- **Growth CSV**: every well with its raw and corrected values.
- **Results CSV**: every method's numbers plus the settings and warnings.
- **SVG / PNG** under each heatmap: a figure-ready image on a white background with a caption.
- **Pooled CSV** in the group view.
- **Export session** saves everything to one `.json` file: raw reads, layouts and settings. **Import session** reopens it, and results are recalculated with the current version of the tool.

> Session files and exports contain unpublished lab data. Keep them in the group's private storage. Do not commit them to this repository or post them publicly without the supervisor's agreement.

---

## For developers

Plain ES2020 with no framework and no build step. The maths modules (`js/parse.js`, `layout.js`, `correct.js`, `methods/*`, `pool.js`, `export.js`) contain no DOM code. They load as browser `<script>`s (attaching to `window.CB`) and under Node `require()`. `index.html` holds the UI only.

```
index.html            UI
css/style.css
js/parse.js           Spark .xlsx + pasted grid -> reads
js/layout.js          presets, layout editor model
js/correct.js         t0 / drift correction, growth fraction, warnings
js/methods/           method registry + FICI, Bliss, HSA
js/pool.js            repeat grouping and pooled summaries
js/export.js          CSV / SVG / PNG / session JSON
js/vendor/            SheetJS 0.20.3 (Apache-2.0), vendored
tests/                node --test suites
reference_analysis.py Python oracle (source of truth for the numbers)
```

### Run the tests
Needs Node 20 or later.

```bash
npm test
```

The acceptance tests in SPEC section 9 need the raw `.xlsx` fixtures in `tests/fixtures/` (same folder names as the lab data folder). That folder is **git-ignored**, so ask a group member for it. It also holds the acceptance tests themselves (`tests/fixtures/acceptance/`), because their expected values are unpublished results, and the full SPEC with section 9 (`tests/fixtures/SPEC_full.md`). `npm test` runs them automatically when the folder is present. Without it, the data-dependent tests are skipped and the rest still run.

To regenerate the oracle values the tests compare against (needs `numpy` and `openpyxl`):

```bash
python3 tests/oracle_dump.py
```

### Run locally

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open http://127.0.0.1:8765. Opening `index.html` directly from disk also works.

### Add a method
Add a file in `js/methods/` that calls `CB.methods.register({id, label, requires, defaults, run, toCSV, pool, poolToCSV})`. Then add its `<script>` tag and a renderer in `index.html`. See `js/methods/index.js` and SPEC section 3.2. The planned additions are growth curves and AUC, Loewe and ZIP.

### Deployment
`.github/workflows/pages.yml` runs the tests and publishes **only** `index.html`, `css/` and `js/` to GitHub Pages on every push to `main`.

One-time setup: in the repository on GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

The published site is public even if the repository is private, which is one more reason never to put data files in `index.html`, `css/` or `js/`.

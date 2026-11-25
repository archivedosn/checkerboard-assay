"""Reference implementation (test oracle) for the checkerboard analysis web tool.

Usage:  python3 reference_analysis.py <data_dir>
<data_dir> is the folder containing "1104 data/" and "cf&clz or pcc 20261109 to 1111/".
Prints the acceptance-test values listed in SPEC.md section 9.

Requires: numpy, openpyxl.
"""
import sys, datetime as dt
import numpy as np, openpyxl

# ---------------------------------------------------------------- parsing
def _cells(row):
    return [v for v in row if v is not None]

def parse_spark(path):
    """Return list of reads: dict(start=datetime, grid=8x12 ndarray, source=str).
    Handles single-read sheets ('<>' grid) and kinetic blocks ('Cycle Nr.' rows).
    Kinetic cycles get start = block start + Time [s]."""
    rows = [list(r) for r in openpyxl.load_workbook(path, data_only=True).active.iter_rows(values_only=True)]
    reads, last_start = [], None
    for i, r in enumerate(rows):
        c = _cells(r)
        if c and isinstance(c[0], str) and c[0].strip() == 'Start Time' and len(c) > 1:
            last_start = dt.datetime.strptime(str(c[1]), '%Y-%m-%d %H:%M:%S')
        if r[0] == '<>':
            g = np.array([[float(rows[i + 1 + k][col]) for col in range(1, 13)] for k in range(8)])
            reads.append(dict(start=last_start, grid=g, source='single'))
        if r[0] == 'Cycle Nr.':
            hdr = [str(h) for h in r if h is not None]
            first_well = hdr.index('A1')
            j = i + 1
            while j < len(rows) and rows[j][0] not in (None, 'End Time'):
                vals = rows[j]
                if sum(v is not None for v in vals) > first_well:   # skip empty/not-executed cycles
                    secs = float(vals[1])
                    g = np.array(vals[first_well:first_well + 96], float).reshape(8, 12)
                    reads.append(dict(start=last_start + dt.timedelta(seconds=secs), grid=g, source='kinetic'))
                j += 1
    return reads

# ---------------------------------------------------------------- analysis
def correct(t0, tx, cellfree=None, use_t0=True, use_drift=True):
    """cellfree: (rows_slice, col) of per-row no-cell wells, or None."""
    d = tx - t0 if use_t0 else tx.copy()
    drift = None
    if cellfree is not None and use_drift:
        drift = d[cellfree].copy()
        d = d - drift[:, None]
    return d, drift

def mic(inhibited, conc):
    """Lowest conc from which this and every higher conc is inhibited. conc[0] must be 0."""
    for i in range(1, len(conc)):
        if all(inhibited[i:]):
            return conc[i], False
    return 2 * conc[-1], True            # off-scale -> bound

def fici_analysis(frac, A, B, cutoff):
    """frac: growth fraction over the matrix only (rows = B, cols = A, [0,0] = drug-free)."""
    inh = frac <= 1 - cutoff
    micA, offA = mic(inh[0, :], A)
    micB, offB = mic(inh[:, 0], B)
    boundary = []
    for r in range(1, len(B)):
        if B[r] >= micB:
            continue
        for c in range(1, len(A)):
            if A[c] > micA:
                break
            if all(inh[r, c:]):
                boundary.append((A[c] / micA + B[r] / micB, A[c], B[r]))
                break
    out = dict(inhibited=inh, micA=micA, offA=offA, micB=micB, offB=offB, boundary=boundary)
    if boundary:
        out['fici_min'] = min(boundary)
        out['fici_max'] = max(boundary)
    out['attainable_floor'] = A[1] / micA + B[1] / micB
    out['near_cutoff'] = [(r, c, frac[r, c]) for r in range(len(B)) for c in range(len(A))
                          if abs(frac[r, c] - (1 - cutoff)) <= 0.02]
    return out

def odds_class(f):
    return 'synergy' if f <= 0.5 else ('antagonism' if f > 4 else 'indifference')

def bliss_hsa(frac):
    g = np.clip(frac, 0, 1)
    E = 1 - g
    EA, EB = E[0, :][None, :], E[:, 0][:, None]
    res = {}
    for name, exp in (('bliss', EA + EB - EA * EB), ('hsa', np.maximum(EA, EB))):
        X = (E - exp)[1:, 1:]                     # combination wells only
        best = max(X[i:i + 3, j:j + 3].mean() for i in range(X.shape[0] - 2) for j in range(X.shape[1] - 2))
        res[name] = dict(excess=X, mean=X.mean(), max3x3=best)
    return res

# ---------------------------------------------------------------- the two test layouts
CF8 = [0, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2]
CLZ8 = [0, 1.5625, 3.125, 6.25, 12.5, 25, 50, 100]
CF10 = [0, 0.0078125, 0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2]
CLZ10 = [0, 0.390625, 0.78125, 1.5625, 3.125, 6.25, 12.5, 25]
PCC10 = [0, 0.1875, 0.375, 0.75, 1.5, 3, 6, 12]

def run(t0, tx, ncol, A, B, cellfree, cutoff=0.95):
    d, drift = correct(t0, tx, cellfree)
    M = d[:, :ncol]
    frac = M / M[0, 0]
    return frac, fici_analysis(frac, A, B, cutoff), bliss_hsa(frac), drift / M[0, 0] * 100

if __name__ == '__main__':
    root = sys.argv[1].rstrip('/') + '/'
    def one(p): return parse_spark(root + p)
    cases = [
        ('1109 CF+CLZ 47h', 'cf&clz or pcc 20261109 to 1111/cfclz/cfclz initial.xlsx',
         'cf&clz or pcc 20261109 to 1111/cfclz/cfclz 47hr.xlsx', 10, CF10, CLZ10, (slice(0, 8), 10)),
        ('1109 CF+PCC 47h', 'cf&clz or pcc 20261109 to 1111/cfpcc/cfpcc initial.xlsx',
         'cf&clz or pcc 20261109 to 1111/cfpcc/cfpcc 47hr.xlsx', 10, CF10, PCC10, (slice(0, 8), 10)),
        ('1104 CF+CLZ 48h', '1104 data/cfclz initial_20261104_104559.xlsx',
         '1104 data/cfclz 48hr_20261106_112532.xlsx', 8, CF8, CLZ8, (slice(0, 8), 8)),
    ]
    for name, f0, fx, ncol, A, B, cf in cases:
        r0, rx = one(f0)[0], one(fx)[0]
        hours = (rx['start'] - r0['start']).total_seconds() / 3600
        frac, f, bh, drift = run(r0['grid'], rx['grid'], ncol, A, B, cf)
        print(f"{name}  ({hours:.1f} h after t0)")
        print(f"  MIC95 A {f['micA']}{' (bound)' if f['offA'] else ''}  MIC95 B {f['micB']}{' (bound)' if f['offB'] else ''}")
        print(f"  FICImin {f['fici_min'][0]:.4f} at A={f['fici_min'][1]} B={f['fici_min'][2]} -> {odds_class(f['fici_min'][0])}")
        print(f"  FICImax {f['fici_max'][0]:.4f} at A={f['fici_max'][1]} B={f['fici_max'][2]}  boundary wells n={len(f['boundary'])}")
        print(f"  attainable floor {f['attainable_floor']:.4f}")
        print(f"  near-cut-off wells (row,col,%): {[(r, c, round(v*100, 1)) for r, c, v in f['near_cutoff']]}")
        print(f"  cell-free drift % of drug-free growth: {np.round(drift, 1).tolist()}")
        print(f"  Bliss mean {bh['bliss']['mean']*100:.2f} pp, max3x3 {bh['bliss']['max3x3']*100:.2f} pp | "
              f"HSA mean {bh['hsa']['mean']*100:.2f} pp, max3x3 {bh['hsa']['max3x3']*100:.2f} pp")

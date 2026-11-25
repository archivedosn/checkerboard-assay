"""Dump what reference_analysis.py parses from every fixture, for the Node tests to compare against.

Usage:  .venv/bin/python tests/oracle_dump.py
Writes, git-ignored with the fixtures because they contain raw data:
  tests/fixtures/oracle_parse.json  every read of every fixture file
  tests/fixtures/oracle_cases.json  the section 9 cases: growth fractions, drift, FICI, Bliss, HSA
"""
import glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import reference_analysis as ref  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')

out = {}
for path in sorted(glob.glob(os.path.join(FIX, '**', '*.xlsx'), recursive=True)):
    rel = os.path.relpath(path, FIX)
    out[rel] = [dict(start=r['start'].strftime('%Y-%m-%d %H:%M:%S.%f'),
                     source=r['source'],
                     grid=r['grid'].tolist()) for r in ref.parse_spark(path)]

with open(os.path.join(FIX, 'oracle_parse.json'), 'w') as f:
    json.dump(out, f)
print(f'wrote {len(out)} files, {sum(map(len, out.values()))} reads')

# ---------------------------------------------------------------- section 9 cases
D9 = 'cf&clz or pcc 20261109 to 1111/'
CASES = [
    ('1109 CF+CLZ', D9 + 'cfclz/cfclz initial.xlsx', D9 + 'cfclz/cfclz 47hr.xlsx',
     'p1109-10x8-clz', 10, ref.CF10, ref.CLZ10, (slice(0, 8), 10)),
    ('1109 CF+PCC', D9 + 'cfpcc/cfpcc initial.xlsx', D9 + 'cfpcc/cfpcc 47hr.xlsx',
     'p1109-10x8-pcc', 10, ref.CF10, ref.PCC10, (slice(0, 8), 10)),
    ('1104 CF+CLZ', '1104 data/cfclz initial_20261104_104559.xlsx', '1104 data/cfclz 48hr_20261106_112532.xlsx',
     'p1104-8x8', 8, ref.CF8, ref.CLZ8, (slice(0, 8), 8)),
]
CUTOFFS = [0.5, 0.8, 0.9, 0.95]

def fici_json(f):
    d = dict(micA=f['micA'], offA=f['offA'], micB=f['micB'], offB=f['offB'],
             boundary=[list(b) for b in f['boundary']],
             floor=f['attainable_floor'],
             near=[[r, c, float(v)] for r, c, v in f['near_cutoff']])
    if f['boundary']:
        d['ficiMin'] = list(f['fici_min'])
        d['ficiMax'] = list(f['fici_max'])
    return d

cases = []
for name, f0, fx, layout, ncol, A, B, cf in CASES:
    r0 = ref.parse_spark(os.path.join(FIX, f0))[0]
    rx = ref.parse_spark(os.path.join(FIX, fx))[0]
    frac, f, bh, drift = ref.run(r0['grid'], rx['grid'], ncol, A, B, cf)
    cases.append(dict(
        name=name, t0File=f0, txFile=fx, layout=layout,
        hours=(rx['start'] - r0['start']).total_seconds() / 3600,
        frac=frac.tolist(), driftPct=drift.tolist(),
        fici={str(c): fici_json(ref.fici_analysis(frac, A, B, c)) for c in CUTOFFS},
        bliss={k: dict(excess=v['excess'].tolist(), mean=float(v['mean']), max3x3=float(v['max3x3']))
               for k, v in bh.items()},
    ))

with open(os.path.join(FIX, 'oracle_cases.json'), 'w') as f:
    json.dump(cases, f)
print(f'wrote {len(cases)} analysis cases')

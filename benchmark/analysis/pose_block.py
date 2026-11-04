"""Pose-block bootstrap intervals for H2, H3 and H4 (protocol §9).

The 160 held-out rows are 4 designs x 10 poses x 4 conditions. Each replicate resamples the
ten poses with replacement within each design, keeping all four conditions and all feature
records of a pose together. Intervals are conditional on the four designs.

    python benchmark/analysis/pose_block.py        # needs numpy; writes out/parts-extra/pose-block.json
"""
import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / 'out'
PARTS = ['pilot-fixture-block', 'pilot-flange-adapter', 'pilot-bearing-housing', 'pilot-sheet-metal-mount']
RESAMPLES, SEED = 50000, 20261104

rows = [dict(r, part=p) for p in PARTS for r in json.loads((OUT / 'parts' / p / 'results.json').read_text())['rows']]
arm = lambda r, a: r['conditions'][a]
failed = lambda x: x['centreErrMm'] > 10 or abs(x['sizeErrPct']) > 10
feat = [dict(f, part=r['part'], trial=r['trial']) for r in rows for f in arm(r, 'B')['features']
        if f['outcome'] != 'not-tested' and f['seen'] is not None]
size_change = np.array([abs(arm(r, 'B')['sizeErrPct']) - abs(arm(r, 'A')['sizeErrPct']) for r in rows])

rng = np.random.default_rng(SEED)
ix = rng.integers(0, 10, size=(RESAMPLES, 4, 10))
h3 = np.zeros((4, 10)); h2 = np.zeros((4, 10, 4)); feats = np.zeros((4, 10, 4))
for pi, part in enumerate(PARTS):
    for t in range(10):
        rs = [r for r in rows if r['part'] == part and r['trial'] == t]
        h3[pi, t] = sum(failed(arm(r, 'B')) - failed(arm(r, 'C')) for r in rs) / 4
        h2[pi, t, :] = [abs(arm(r, 'B')['sizeErrPct']) - abs(arm(r, 'A')['sizeErrPct']) for r in rs]
        fs = [f for f in feat if f['part'] == part and f['trial'] == t]
        feats[pi, t, :] = [sum(f['seen'] and f['outcome'] == 'recovered' for f in fs), sum(f['seen'] for f in fs),
                           sum(not f['seen'] and f['outcome'] == 'recovered' for f in fs), sum(not f['seen'] for f in fs)]
h3draw = np.mean(np.stack([h3[p, ix[:, p, :]] for p in range(4)], axis=1), axis=(1, 2))
h2draw = np.median(np.stack([h2[p, ix[:, p, :], :] for p in range(4)], axis=1).reshape(RESAMPLES, -1), axis=1)
fdraw = np.sum(np.stack([feats[p, ix[:, p, :], :] for p in range(4)], axis=1), axis=(1, 2))
seen, hidden = fdraw[:, 0] / fdraw[:, 1], fdraw[:, 2] / fdraw[:, 3]
ci = lambda a: [float(v) for v in np.quantile(a, [.025, .975])]

result = {
    'resamples': RESAMPLES, 'seed': SEED,
    'scheme': 'four fixed designs; ten poses resampled within each design; four conditions and all features of a pose kept together',
    'H3_failure_reduction': {'estimate': float(np.mean(h3)), 'CI': ci(h3draw)},
    'H2_median_diff': {'estimate': float(np.median(size_change)), 'CI': ci(h2draw)},
    'H4_seen_rate_CI': ci(seen), 'H4_hidden_rate_CI': ci(hidden), 'H4_difference_CI': ci(seen - hidden),
}
(OUT / 'parts-extra').mkdir(parents=True, exist_ok=True)
(OUT / 'parts-extra' / 'pose-block.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))

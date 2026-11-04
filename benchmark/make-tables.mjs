// Turns the benchmark output into LaTeX macros, table rows and pgfplots data for the
// paper: out/results.tex and out/plot-*.dat.
//   node make-tables.mjs
//
// Reads out/results.json (main run), out/results-recon-noisycrop.json
// (segmentation-like generator inputs),
// out/sensitivity.json, out/frametimes.json and cache/recon*/trial-<i>.json. Missing
// optional inputs produce `--`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { OUT, CACHE, PAPER } from './paths.mjs';
const load = (name) => { const f = path.join(OUT, name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const { results } = load('results.json');
const frames = load('frametimes.json');
// sensitivity.json, plus per-range files from parallel runs (bench.html?stage=sensitivity&trials=a-b);
// a trial present in a range file replaces the same trial in the main file.
const sens = (() => {
  const main = load('sensitivity.json');
  const parts = fs.readdirSync(OUT).filter((f) => /^sensitivity-\d+-\d+\.json$/.test(f)).map(load);
  if (!parts.length) return main;
  const ranged = new Set(parts.flatMap((p) => p.results.map((r) => r.i)));
  const results = [...(main?.results ?? []).filter((r) => !ranged.has(r.i)), ...parts.flatMap((p) => p.results)].sort((a, b) => a.i - b.i);
  return { conditions: (main ?? parts[0]).conditions, results };
})();
const reconSeconds = (dir) => {
  const d = path.join(CACHE, dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^trial-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).seconds) : [];
};

// ── Statistics ──────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const quantile = (a, q) => { const b = [...a].sort((x, y) => x - y); const p = (b.length - 1) * q, lo = Math.floor(p); return b[lo] + (b[Math.min(lo + 1, b.length - 1)] - b[lo]) * (p - lo); };
const median = (a) => quantile(a, 0.5);
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
/** Percentile bootstrap over trials (10 000 resamples, fixed seed). */
function bootstrap(a, stat = mean, B = 10000, seed = 20261006) {
  const r = rng(seed), out = [];
  for (let b = 0; b < B; b++) out.push(stat(a.map(() => a[Math.floor(r() * a.length)])));
  return [quantile(out, 0.025), quantile(out, 0.975)];
}
/** Wilson score interval for k successes out of n (95 %). */
function wilson(k, n, z = 1.959964) {
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
const ranks = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
const pearson = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0; x.forEach((v, i) => { n += (v - mx) * (y[i] - my); dx += (v - mx) ** 2; dy += (y[i] - my) ** 2; }); return n / Math.sqrt(dx * dy); };
const spearman = (x, y) => pearson(ranks(x), ranks(y));

const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace(/^-(0\.?0*)$/, '$1') : '--');   // no negative zero
const pm = (a, d = 1) => `${f(mean(a), d)}\\,$\\pm$\\,${f(sd(a), d)}`;
const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(0)}\\,\\%` : '--');
const ci = ([lo, hi], d = 1) => `${f(lo, d)}--${f(hi, d)}`;

// ── Table 1: registration variants ──────────────────────────────────────────
const VARIANTS = [
  ['naive', 'Naive drop (fixed size, no rotation)'],
  ['silhouette', 'Silhouette only (7 DoF)'],
  ['silhouetteLong', '\\quad with 6.3$\\times$ budget, 8 starts'],
  ['support', '+ support plane (4 DoF)'],
  ['supportDeclared', '+ declared size (AAS)'],
  ['twoViews', '+ second camera'],
  ['twoViewsNoisy', '\\quad with degraded masks'],
];
const col = (rows, v, key, fn = (x) => x) => rows.filter((r) => r.variants[v]).map((r) => fn(r.variants[v][key]));
const within = (rows, v, mm = 10) => rows.filter((r) => r.variants[v]?.centreErrMm < mm).length;
const tableRows = VARIANTS.filter(([v]) => results[0].variants[v]).map(([v, label]) => {
  const centre = col(results, v, 'centreErrMm'), size = col(results, v, 'sizeErrPct', Math.abs), chamfer = col(results, v, 'chamferMm'), hd = col(results, v, 'hausdorffMm');
  const iou = col(results, v, 'iou', (a) => a[0]), ms = col(results, v, 'ms');
  return `${label} & ${pm(centre)} & ${f(median(centre))} & ${pm(size)} & ${pm(chamfer, 2)} & ${pm(hd, 1)} & ${f(mean(iou), 3)} & ${within(results, v)}/${results.length} & ${v === 'naive' ? '--' : f(median(ms) / 1000, 1)} \\\\`;
});

// ── Headline statistics ─────────────────────────────────────────────────────
const N = results.length;
const best = col(results, 'twoViews', 'centreErrMm'), bestCh = col(results, 'twoViews', 'chamferMm');
const worst = results.reduce((w, r) => (r.variants.twoViews.centreErrMm > w.variants.twoViews.centreErrMm ? r : w));
const bestWithin = within(results, 'twoViews');
const paired = (a, b, key = 'centreErrMm') => results.map((r) => r.variants[b][key] - r.variants[a][key]);
const improves = (a, b, key = 'centreErrMm') => paired(a, b, key).filter((d) => d < 0).length;
const turnedDiff = results.filter((r) => r.variants.supportDeclaredTurned).map((r) => Math.abs(r.variants.supportDeclaredTurned.centreErrMm - r.variants.supportDeclared.centreErrMm));
const heldOut = results.filter((r) => r.variants.supportDeclared?.heldOutIoU !== undefined);
const heldIoU = heldOut.map((r) => r.variants.supportDeclared.heldOutIoU), heldCh = heldOut.map((r) => r.variants.supportDeclared.chamferMm);

// Scale–depth family (exact silhouette ambiguity), averaged over trials.
const fam = results.filter((r) => r.scaleFamily);
const ks = fam.length ? fam[0].scaleFamily.map((x) => x.k) : [];
const famRows = ks.map((k, j) => ({ k, inspection: mean(fam.map((r) => r.scaleFamily[j].iouInspection)), cell: mean(fam.map((r) => r.scaleFamily[j].iouCell)), lift: mean(fam.map((r) => r.scaleFamily[j].baseAboveSupportMm)) }));
const famAt = (k) => famRows.find((x) => x.k === k);

// Coverage: corrected visibility, observed vs inferred error per trial.
const cov = results.filter((r) => r.coverage);
const covDiff = cov.map((r) => r.coverage.inferred.mean - r.coverage.observed.mean);
const covDiffNoWorst = cov.filter((r) => r.i !== worst.i).map((r) => r.coverage.inferred.mean - r.coverage.observed.mean);

// Holes: outcomes by visibility; trial-level view.
const holes = results.flatMap((r) => (r.holes ?? []).map((h) => ({ ...h, trial: r.i })));
const seen = holes.filter((h) => h.seen), unseen = holes.filter((h) => !h.seen);
const count = (a, o) => a.filter((h) => h.outcome === o).length;
const mixed = results.filter((r) => r.holes?.some((h) => h.seen) && r.holes?.some((h) => !h.seen)).length;
const trialsWithSeen = results.filter((r) => r.holes?.some((h) => h.seen));
const trialsSeenRecovered = trialsWithSeen.filter((r) => r.holes.some((h) => h.seen && h.recovered)).length;
const trialsWithUnseen = results.filter((r) => r.holes?.some((h) => !h.seen));
const trialsUnseenRecovered = trialsWithUnseen.filter((r) => r.holes.some((h) => !h.seen && h.recovered)).length;

// ── Sensitivity (Table 2) ───────────────────────────────────────────────────
const SENS = [
  ['none', 'Exact twin', (v) => '--'],
  ['declaredSize', 'Declared size', (v) => `$\\times$${v}`],
  ['cameraRotDeg', 'Camera rotation', (v) => `${v}$^\\circ$`],
  ['cameraShiftMm', 'Camera position', (v) => `${v}\\,mm`],
  ['supportMm', 'Support height', (v) => `${v > 0 ? '+' : ''}${v}\\,mm`],
];
const sensRows = !sens ? [] : SENS.flatMap(([kind, label, fmt]) => [...new Set(sens.results.filter((r) => r.kind === kind).map((r) => r.value))].map((value, j) => {
  const rs = sens.results.filter((r) => r.kind === kind && r.value === value);
  const c = rs.map((r) => r.centreErrMm), ch = rs.map((r) => r.chamferMm), sz = rs.map((r) => r.sizeErrPct);
  return `${j === 0 ? label : ''} & ${fmt(value)} & ${f(median(c))} & ${f(mean(c))} & ${f(median(sz))} & ${f(median(ch), 2)} & ${rs.filter((r) => r.centreErrMm < 10).length}/${rs.length} \\\\`;
}));

// ── Generator inputs (Table 3) ──────────────────────────────────────────────
// The generation service is deterministic for a given image (other seed values return
// byte-identical meshes), so the generator's variability is probed through its input.
const SETS = [
  ['results.json', 'recon', 'Exact crop (main run)'],
  ['results-recon-noisycrop.json', 'recon-noisycrop', 'Segmentation-like crop'],
];
const setRow = (rows, label) => {
  const c = col(rows, 'twoViews', 'centreErrMm'), ch = col(rows, 'twoViews', 'chamferMm'), naive = col(rows, 'naive', 'centreErrMm');
  const hs = rows.flatMap((r) => r.holes ?? []), s = hs.filter((h) => h.seen), u = hs.filter((h) => !h.seen);
  const cv = rows.filter((r) => r.coverage).map((r) => 100 * r.coverage.fraction);
  return `${label} & ${rows.length} & ${f(median(naive))} & ${f(median(c))} & ${f(mean(c))} & ${within(rows, 'twoViews')}/${rows.length} & ${f(median(ch), 2)} & ${f(mean(cv))} & ${s.filter((h) => h.recovered).length}/${s.length} & ${u.filter((h) => h.recovered).length}/${u.length} \\\\`;
};
const sets = SETS.map(([file, dir, label]) => ({ rows: load(file)?.results, dir, label })).filter((x) => x.rows?.length);
const setRows = sets.map((x) => setRow(x.rows, x.label));
// Determinism of the generation service: reruns with seed 1 (cache/recon-seed1) against
// the main run, by SHA-256 of the meshes; saved to out/rerun-hashes.json, which is used
// when the rerun meshes are not on disk.
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rerunDir = path.join(CACHE, 'recon-seed1');
let rerunHashes = load('rerun-hashes.json');
if (fs.existsSync(rerunDir)) {
  rerunHashes = fs.readdirSync(rerunDir).filter((f) => /^trial-\d+\.glb$/.test(f))
    .map((f) => ({ file: f, main: digest(path.join(CACHE, 'recon', f)), rerun: digest(path.join(rerunDir, f)) }));
  fs.writeFileSync(path.join(OUT, 'rerun-hashes.json'), JSON.stringify(rerunHashes, null, 2));
}
const reruns = rerunHashes ?? [];
const identical = reruns.filter((h) => h.main === h.rerun).length;
const allSeconds = sets.flatMap((x) => reconSeconds(x.dir));

// ── Macros ──────────────────────────────────────────────────────────────────
const timing = results.filter((r) => r.timing);
const macros = {
  resTrials: N,
  resReconSeconds: f(mean(reconSeconds('recon')), 0),
  resReconSecondsSd: f(sd(reconSeconds('recon')), 0),
  resReconCount: allSeconds.length,
  resReconAllSeconds: f(mean(allSeconds), 0),
  resCoverage: f(100 * mean(cov.map((r) => r.coverage.fraction)), 1),
  resCoverageSd: f(100 * sd(cov.map((r) => r.coverage.fraction)), 1),
  resDevObserved: f(mean(cov.map((r) => r.coverage.observed.mean)), 2),
  resDevInferred: f(mean(cov.map((r) => r.coverage.inferred.mean)), 2),
  resDevObservedPninetyfive: f(mean(cov.map((r) => r.coverage.observed.p95)), 2),
  resDevInferredPninetyfive: f(mean(cov.map((r) => r.coverage.inferred.p95)), 2),
  resCovInferredWorse: `${covDiff.filter((d) => d > 0).length}/${cov.length}`,
  resCovDiff: f(mean(covDiff), 2),
  resCovDiffCI: ci(bootstrap(covDiff), 2),
  resCovDiffMedian: f(median(covDiff), 2),
  resCovDiffNoFail: f(mean(covDiffNoWorst), 2),
  resHolesSeen: `${seen.filter((h) => h.recovered).length}/${seen.length}`, resHolesSeenPct: pct(seen.filter((h) => h.recovered).length, seen.length),
  resHolesUnseen: `${unseen.filter((h) => h.recovered).length}/${unseen.length}`, resHolesUnseenPct: pct(unseen.filter((h) => h.recovered).length, unseen.length),
  resHolesSeenMissing: count(seen, 'missing'), resHolesSeenNoPlate: count(seen, 'no-plate'), resHolesSeenWrongSize: count(seen, 'wrong-size'),
  resHolesUnseenMissing: count(unseen, 'missing'), resHolesUnseenNoPlate: count(unseen, 'no-plate'), resHolesUnseenWrongSize: count(unseen, 'wrong-size'),
  resRerunIdentical: reruns.length ? `${identical}/${reruns.length}` : '--',
  resHolesMixedTrials: mixed,
  resHolesUnseenMissingTotal: unseen.length,
  resHolesTrialsSeen: `${trialsSeenRecovered}/${trialsWithSeen.length}`,
  resHolesTrialsUnseen: `${trialsUnseenRecovered}/${trialsWithUnseen.length}`,
  resNaiveChamfer: f(mean(col(results, 'naive', 'chamferMm')), 1),
  resBestChamfer: f(mean(bestCh), 2),
  resBestChamferCI: ci(bootstrap(bestCh), 2),
  resBestCentre: f(mean(best), 1),
  resBestCentreCI: ci(bootstrap(best)),
  resBestSize: f(mean(col(results, 'twoViews', 'sizeErrPct', Math.abs)), 1),
  resBestWithinTen: `${bestWithin}/${N}`,
  resBestWithinTenCI: `${f(100 * wilson(bestWithin, N)[0], 0)}--${f(100 * wilson(bestWithin, N)[1], 0)}\\,\\%`,
  resFailTrial: worst.i,
  resFailCentre: f(worst.variants.twoViews.centreErrMm, 1),
  resFailShareCentre: f((100 * worst.variants.twoViews.centreErrMm) / best.reduce((s, v) => s + v, 0), 0),
  resFailShareChamfer: f((100 * worst.variants.twoViews.chamferMm) / bestCh.reduce((s, v) => s + v, 0), 0),
  resBestCentreNoFail: f(mean(results.filter((r) => r.i !== worst.i).map((r) => r.variants.twoViews.centreErrMm)), 1),
  resSupportCentre: f(mean(col(results, 'support', 'centreErrMm')), 1),
  resDeclaredCentre: f(mean(col(results, 'supportDeclared', 'centreErrMm')), 1),
  resPriorImproves: `${improves('support', 'supportDeclared')}/${N}`,
  resViewImproves: `${improves('supportDeclared', 'twoViews')}/${N}`,
  resPriorImprovesChamfer: `${improves('support', 'supportDeclared', 'chamferMm')}/${N}`,
  resViewImprovesChamfer: `${improves('supportDeclared', 'twoViews', 'chamferMm')}/${N}`,
  resSilhouetteCentre: f(mean(col(results, 'silhouette', 'centreErrMm')), 0),
  resSilhouetteIoU: f(mean(col(results, 'silhouette', 'iou', (a) => a[0])), 2),
  resSilLongCentre: f(mean(col(results, 'silhouetteLong', 'centreErrMm')), 0),
  resSilLongCentreMedian: f(median(col(results, 'silhouetteLong', 'centreErrMm')), 0),
  resSilLongIoU: f(mean(col(results, 'silhouetteLong', 'iou', (a) => a[0])), 2),
  resSilLongEvals: f(median(col(results, 'silhouetteLong', 'evals')), 0),
  resSilEvals: f(median(col(results, 'silhouette', 'evals')), 0),
  resTurnedMaxDiff: f(turnedDiff.length ? Math.max(...turnedDiff) : NaN, 2),
  resTurnedMeanDiff: f(turnedDiff.length ? mean(turnedDiff) : NaN, 2),
  resFamilyIoUHalf: f(famAt(0.5)?.inspection, 3),
  resFamilyIoUOne: f(famAt(1)?.inspection, 3),
  resFamilyLiftHalf: f(famAt(0.5)?.lift, 0),
  resFamilyCellHalf: f(famAt(0.5)?.cell, 2),
  resFamilyCellOne: f(famAt(1)?.cell, 2),
  resHeldOutRho: f(heldIoU.length ? spearman(heldIoU, heldCh) : NaN, 2),
  resHeldOutFail: f(worst.variants.supportDeclared?.heldOutIoU, 2),
  resHeldOutOthersMin: f(Math.min(...heldOut.filter((r) => r.i !== worst.i).map((r) => r.variants.supportDeclared.heldOutIoU)), 2),
  resBestCentreMedian: f(median(best), 1),
  resBestChamferMedian: f(median(bestCh), 2),
  resNaiveCentreMedian: f(median(col(results, 'naive', 'centreErrMm')), 1),
  resBestIoU: f(mean(col(results, 'twoViews', 'iou', (a) => a[0])), 2),
  resNoisyChamfer: f(mean(col(results, 'twoViewsNoisy', 'chamferMm')), 2),
  resNoisyCentre: f(mean(col(results, 'twoViewsNoisy', 'centreErrMm')), 1),
  resRegSeconds: f(median(col(results, 'twoViews', 'ms')) / 1000, 1),
  resFramePlain: f(frames?.plainMs, 1),
  resFrameShaded: f(frames?.shadedMs, 1),
  resFramePlainSd: f(frames?.plainSd, 1),
  resFrameShadedSd: f(frames?.shadedSd, 1),
  resFrameDiff: f(frames?.diffMs, 2),
  resFrameDiffSd: f(frames?.diffSd, 2),
  resFrameRuns: frames?.runs ?? '--',
  resCoverageMs: f(median(timing.map((r) => r.timing.coverageMs)), 0),
  resDeviationMs: f(median(timing.map((r) => r.timing.deviationMs)), 0),
  resTriangles: f(median(timing.map((r) => r.timing.triangles)) / 1000, 0),
};

const tex = [
  '% Generated by make-tables.mjs from the benchmark output — do not edit.',
  ...Object.entries(macros).map(([k, v]) => `\\newcommand{\\${k}}{${v}}`),
  `\\newcommand{\\resRegistrationRows}{${tableRows.join('\n')}}`,
  `\\newcommand{\\resSensitivityRows}{${sensRows.join('\n')}}`,
  `\\newcommand{\\resSeedRows}{${setRows.join('\n')}}`,
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'results.tex'), tex);
fs.writeFileSync(path.join(PAPER, 'results.tex'), tex);

// ── pgfplots data ───────────────────────────────────────────────────────────
const dat = (name, header, rows) => fs.writeFileSync(path.join(PAPER, name), [header.join(' '), ...rows.map((r) => r.map((v) => (typeof v === 'number' ? +v.toFixed(4) : v)).join(' '))].join('\n') + '\n');
// Per-trial centre error along naive → support → +declared size → +second view: one
// line per trial, separated by blank lines (pgfplots `empty line=jump`), and the median.
const STEPS = ['naive', 'support', 'supportDeclared', 'twoViews'];
fs.writeFileSync(path.join(PAPER, 'plot-paired-long.dat'), 'x y\n' + results.map((r) => STEPS.map((v, x) => `${x} ${r.variants[v].centreErrMm.toFixed(4)}`).join('\n')).join('\n\n') + '\n');
dat('plot-paired-median.dat', ['x', 'median'], STEPS.map((v, x) => [x, median(col(results, v, 'centreErrMm'))]));
dat('plot-family.dat', ['k', 'inspection', 'cell', 'lift'], famRows.map((x) => [x.k, x.inspection, x.cell, x.lift]));
dat('plot-heldout.dat', ['trial', 'heldout', 'chamfer', 'fail'], heldOut.map((r) => [r.i, r.variants.supportDeclared.heldOutIoU, r.variants.supportDeclared.chamferMm, r.i === worst.i ? 1 : 0]));
dat('plot-coverage.dat', ['trial', 'observed', 'inferred', 'fraction'], cov.map((r) => [r.i, r.coverage.observed.mean, r.coverage.inferred.mean, r.coverage.fraction]));
if (sens) {
  for (const kind of ['declaredSize', 'cameraRotDeg', 'cameraShiftMm', 'supportMm']) {
    const values = [...new Set(sens.results.filter((r) => r.kind === kind).map((r) => r.value))].sort((a, b) => a - b);
    dat(`plot-sens-${kind}.dat`, ['value', 'median', 'q25', 'q75'], values.map((v) => { const c = sens.results.filter((r) => r.kind === kind && r.value === v).map((r) => r.centreErrMm); return [v, median(c), quantile(c, 0.25), quantile(c, 0.75)]; }));
  }
}
console.log(tex);

// Analysis of the multi-part experiment (protocol §9): LaTeX macros, table rows
// and pgfplots data for the paper, and a JSON summary.
//   node make-parts-tables.mjs [--results <file name, default results.json>]
//
// Reads out/parts/<id>/<file> for the four test parts; writes out/parts/results-parts.tex,
// out/parts/summary.json and out/parts/plot-*.dat. Every trial is counted; skipped conditions and
// failed generations are reported, never dropped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { OUT as OUT_ROOT, PAPER } from './paths.mjs';
const OUT = path.join(OUT_ROOT, 'parts');
const FILE = (() => { const i = process.argv.indexOf('--results'); return i > 0 ? process.argv[i + 1] : 'results.json'; })();
const PARTS = [
  ['pilot-fixture-block', 'Fixture block'], ['pilot-flange-adapter', 'Flange adapter'],
  ['pilot-bearing-housing', 'Bearing housing'], ['pilot-sheet-metal-mount', 'Sheet-metal mount'],
];
const CONDS = ['standard', 'occlusion', 'limited', 'reflective'];
const ARMS = ['naive', 'A', 'B', 'C', 'D'];

// ── Statistics ──────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const quantile = (a, q) => { const b = [...a].sort((x, y) => x - y); if (!b.length) return NaN; const p = (b.length - 1) * q, lo = Math.floor(p); return b[lo] + (b[Math.min(lo + 1, b.length - 1)] - b[lo]) * (p - lo); };
const median = (a) => quantile(a, 0.5);
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
/** Trial-clustered bootstrap: resample parts, then trials within each part (median interval for H1). */
function clusteredBootstrap(groups, stat, B = 5000, seed = 20261006) {
  const r = rng(seed), out = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let g = 0; g < groups.length; g++) { const grp = groups[Math.floor(r() * groups.length)]; for (let k = 0; k < grp.length; k++) sample.push(grp[Math.floor(r() * grp.length)]); }
    out.push(stat(sample));
  }
  return [quantile(out, 0.025), quantile(out, 0.975)];
}
function bootstrap(a, stat, B = 5000, seed = 20261006) { const r = rng(seed), out = []; for (let b = 0; b < B; b++) out.push(stat(a.map(() => a[Math.floor(r() * a.length)]))); return [quantile(out, 0.025), quantile(out, 0.975)]; }
function wilson(k, n, z = 1.959964) { if (!n) return [NaN, NaN]; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - h) / d, (c + h) / d]; }
/** Exact two-sided McNemar test on discordant pairs b (only X fails) and c (only Y fails). */
function mcnemar(b, c) { const n = b + c; if (!n) return 1; let p = 0; const k = Math.min(b, c); for (let i = 0; i <= k; i++) p += binom(n, i) * 0.5 ** n; return Math.min(1, 2 * p); }
function binom(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }
/** Wilcoxon signed-rank (normal approximation with tie correction), two-sided p. */
function wilcoxon(d) {
  const x = d.filter((v) => v !== 0).map((v) => ({ v, a: Math.abs(v) })).sort((p, q) => p.a - q.a);
  const n = x.length; if (n < 6) return NaN;
  let i = 0; const ranks = new Array(n); let tie = 0;
  while (i < n) { let j = i; while (j + 1 < n && x[j + 1].a === x[i].a) j++; const r = (i + j + 2) / 2; for (let k = i; k <= j; k++) ranks[k] = r; const t = j - i + 1; tie += t ** 3 - t; i = j + 1; }
  const W = x.reduce((s, p, k) => s + (p.v > 0 ? ranks[k] : 0), 0);
  const mu = n * (n + 1) / 4, sigma = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24 - tie / 48);
  const z = (W - mu) / sigma, phi = (t) => 0.5 * (1 + erf(t / Math.SQRT2));
  return 2 * (1 - phi(Math.abs(z)));
}
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');
const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}\\,\\%` : '--');

// ── Load ────────────────────────────────────────────────────────────────────
const data = PARTS.map(([id, label]) => {
  const file = path.join(OUT, id, FILE);
  return { id, label, rows: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).rows : [] };
});
const all = data.flatMap((p) => p.rows.map((r) => ({ ...r, part: p.id })));
const live = (rows, cond) => rows.filter((r) => !r.skipped && (!cond || r.cond === cond));
/** Rows that count for an arm: every row, in every arm. */
const forArm = (rows) => rows;
const arm = (r, a) => r.conditions?.[a];
const failed = (x) => !x || x.failed !== false;   // no result counts as a failure (protocol §6)
/** Failure under the box-of-boxes extents (protocol §6), reported alongside as a sensitivity. */
const failedBoxOfBoxes = (x) => !x || !x.boxOfBoxes ? failed(x) : x.boxOfBoxes.centreErrMm > 10 || Math.abs(x.boxOfBoxes.sizeErrPct) > 10;
const summary = { protocol: 'protocol/PROTOCOL.md', file: FILE, parts: {}, pooled: {}, tests: {} };

// ── Per part × condition × arm ──────────────────────────────────────────────
function cellStats(allRows, a) {
  const rows = forArm(allRows, a);
  const xs = rows.map((r) => arm(r, a));
  const ok = xs.filter((x) => x && Number.isFinite(x.centreErrMm));
  const fails = xs.filter(failed).length;
  return {
    n: rows.length, failures: fails, failureCI: wilson(fails, rows.length),
    centreMedian: median(ok.map((x) => x.centreErrMm)), centreMedianCI: ok.length ? bootstrap(ok.map((x) => x.centreErrMm), median) : [NaN, NaN],
    sizeAbsMedian: median(ok.map((x) => Math.abs(x.sizeErrPct))), chamferMedian: median(ok.map((x) => x.chamferMm)),
    heightAbsMedian: median(ok.map((x) => Math.abs(x.dims?.heightErrMm))), longAbsMedian: median(ok.map((x) => Math.abs(x.dims?.longErrMm))), shortAbsMedian: median(ok.map((x) => Math.abs(x.dims?.shortErrMm))),
    generations: mean(xs.map((x) => x?.generations ?? (a === 'naive' ? 1 : NaN)).filter(Number.isFinite)),
    coverage: mean(ok.map((x) => x.coverage).filter(Number.isFinite)),
  };
}
for (const p of data) {
  summary.parts[p.id] = {};
  for (const c of CONDS) { const rows = live(p.rows, c); summary.parts[p.id][c] = Object.fromEntries(ARMS.map((a) => [a, cellStats(rows, a)])); summary.parts[p.id][c].skipped = p.rows.filter((r) => r.cond === c && r.skipped).length; }
}
// Pooled over parts (trial-clustered).
for (const c of CONDS) {
  summary.pooled[c] = {};
  for (const a of ARMS) {
    const groups = data.map((p) => forArm(live(p.rows, c), a).map((r) => arm(r, a)));
    const flat = groups.flat();
    const fails = flat.filter(failed).length;
    const ok = flat.filter((x) => x && Number.isFinite(x.centreErrMm));
    summary.pooled[c][a] = {
      n: flat.length, failures: fails, failureRate: fails / Math.max(1, flat.length),
      failureCI: clusteredBootstrap(groups.filter((g) => g.length), (s) => s.filter(failed).length / s.length),
      centreMedian: median(ok.map((x) => x.centreErrMm)),
      centreMedianCI: clusteredBootstrap(groups.map((g) => g.filter((x) => x && Number.isFinite(x.centreErrMm))).filter((g) => g.length), (s) => median(s.map((x) => x.centreErrMm))),
      chamferMedian: median(ok.map((x) => x.chamferMm)), sizeAbsMedian: median(ok.map((x) => Math.abs(x.sizeErrPct))),
      generations: mean(flat.map((x) => x?.generations ?? 1)),
    };
  }
}

// ── Hypothesis tests (exploratory) ──────────────────────────────────────────
const pairs = (rows, a, b, key) => rows.filter((r) => Number.isFinite(arm(r, a)?.[key]) && Number.isFinite(arm(r, b)?.[key]));
// H1: B vs naive, standard condition, per part.
summary.tests.H1 = Object.fromEntries(data.map((p) => { const rows = live(p.rows, 'standard'); const s = summary.parts[p.id].standard; const ps = pairs(rows, 'naive', 'B', 'centreErrMm');
  return [p.id, { medianB: s.B.centreMedian, medianBCI: s.B.centreMedianCI, medianNaive: s.naive.centreMedian, holds: s.B.centreMedian <= 10 && s.B.centreMedian < s.naive.centreMedian, wilcoxonP: wilcoxon(ps.map((r) => arm(r, 'B').centreErrMm - arm(r, 'naive').centreErrMm)) }]; }));
// H2: |size error| B vs A.
const h2 = (rows) => { const ps = pairs(rows, 'A', 'B', 'sizeErrPct'); const d = ps.map((r) => Math.abs(arm(r, 'B').sizeErrPct) - Math.abs(arm(r, 'A').sizeErrPct)); return { n: d.length, medianDiff: median(d), improved: d.filter((x) => x < 0).length, wilcoxonP: wilcoxon(d) }; };
summary.tests.H2 = { pooled: h2(live(all)), ...Object.fromEntries(CONDS.map((c) => [c, h2(live(all, c))])) };
// H3: failures C vs B (McNemar), C vs D generations.
const h3 = (allRows) => { const rows = forArm(allRows, 'C'); let b = 0, c = 0; for (const r of rows) { const fb = failed(arm(r, 'B')), fc = failed(arm(r, 'C')); if (fb && !fc) b++; if (!fb && fc) c++; }
  const fd = rows.filter((r) => failed(arm(r, 'D'))).length;
  return { n: rows.length, failB: rows.filter((r) => failed(arm(r, 'B'))).length, failC: rows.filter((r) => failed(arm(r, 'C'))).length, failD: fd, fixedByC: b, brokenByC: c, mcnemarP: mcnemar(b, c),
    genC: mean(rows.map((r) => arm(r, 'C')?.generations ?? 1)), genD: mean(rows.map((r) => arm(r, 'D')?.generations ?? 1)), unverifiedC: rows.filter((r) => arm(r, 'C')?.unverified).length }; };
summary.tests.H3 = { pooled: h3(live(all)), ...Object.fromEntries(CONDS.map((c) => [c, h3(live(all, c))])) };
// Verification as a trust signal: does the twin's verdict predict placement failure?
// First candidate (the inspection generation, i.e. arm B's result) and the candidate C finally accepts.
const trust = (allRows) => {
  const rows = forArm(allRows, 'C');
  const cell = (ok, verified) => rows.filter((r) => ok(r) && verified(r)).length;
  const firstVerified = (r) => arm(r, 'C')?.decisions?.[0]?.verified === true;
  const finalVerified = (r) => arm(r, 'C') && !arm(r, 'C').unverified;
  const failB = (r) => failed(arm(r, 'B')), failC = (r) => failed(arm(r, 'C'));
  const not = (g) => (r) => !g(r);
  return {
    n: rows.length,
    first: { verifiedOk: cell(not(failB), firstVerified), verifiedFail: cell(failB, firstVerified), flaggedOk: cell(not(failB), not(firstVerified)), flaggedFail: cell(failB, not(firstVerified)) },
    final: { verifiedOk: cell(not(failC), finalVerified), verifiedFail: cell(failC, finalVerified), flaggedOk: cell(not(failC), not(finalVerified)), flaggedFail: cell(failC, not(finalVerified)) },
  };
};
summary.tests.trust = { pooled: trust(live(all)), ...Object.fromEntries(CONDS.map((c) => [c, trust(live(all, c))])) };
// H4: feature recovery by visibility (arm B, all conditions), with trial-clustered intervals.
const featureRows = (a) => live(all).flatMap((r) => (arm(r, a)?.features ?? []).filter((x) => x.outcome !== 'not-tested' && x.seen !== null).map((x) => ({ ...x, part: r.part, trial: r.trial, cond: r.cond })));
const h4 = (a) => {
  const fr = featureRows(a), seen = fr.filter((x) => x.seen), unseen = fr.filter((x) => !x.seen);
  const byTrial = (xs) => Object.values(xs.reduce((m, x) => { (m[`${x.part}|${x.trial}|${x.cond}`] ??= []).push(x); return m; }, {}));
  const rate = (xs) => xs.filter((x) => x.outcome === 'recovered').length / Math.max(1, xs.length);
  return { seen: { n: seen.length, recovered: seen.filter((x) => x.outcome === 'recovered').length, rateCI: clusteredBootstrap(byTrial(seen), rate) },
    unseen: { n: unseen.length, recovered: unseen.filter((x) => x.outcome === 'recovered').length, rateCI: clusteredBootstrap(byTrial(unseen), rate) },
    outcomes: Object.fromEntries(['recovered', 'partial', 'missing', 'no-body'].map((o) => [o, { seen: seen.filter((x) => x.outcome === o).length, unseen: unseen.filter((x) => x.outcome === o).length }])) };
};
summary.tests.H4 = { B: h4('B'), C: h4('C') };
// H5: failure rate per condition (B and C).
summary.tests.H5 = Object.fromEntries(CONDS.map((c) => [c, { B: summary.pooled[c].B.failureRate, C: summary.pooled[c].C.failureRate }]));

fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

// ── LaTeX ───────────────────────────────────────────────────────────────────
const P = summary.pooled;
const rowsPart = data.map((p) => {
  const s = summary.parts[p.id].standard;
  return `${p.label} & ${f(s.naive.centreMedian)} & ${f(s.A.centreMedian)} & ${f(s.B.centreMedian)} & ${f(s.C.centreMedian)} & ${f(s.B.sizeAbsMedian)} & ${f(s.B.heightAbsMedian)} & ${f(s.B.chamferMedian, 2)} & ${s.B.failures}/${s.B.n} & ${s.C.n ? `${s.C.failures}/${s.C.n}` : '--'} \\\\`;
});
const rowsCond = CONDS.map((c) => {
  const q = P[c], t = summary.tests.H3[c];
  return `${c} & ${q.B.n} & ${f(q.A.centreMedian)} & ${f(q.B.centreMedian)} & ${f(q.C.centreMedian)} & ${f(q.D.centreMedian)} & ${q.A.failures} & ${q.B.failures} & ${q.C.n ? q.C.failures : '--'} & ${q.D.n ? q.D.failures : '--'} & ${f(t.genC, 2)} & ${f(t.genD, 2)} \\\\`;
});
const H3 = summary.tests.H3.pooled, H4 = summary.tests.H4.B, H2 = summary.tests.H2.pooled;
const macros = {
  ptTrials: all.filter((r) => !r.skipped).length,
  ptSkipped: all.filter((r) => r.skipped).length,
  ptFailB: `${H3.failB}/${H3.n}`,
  ptFailBAll: (() => { const r = live(all); return `${r.filter((x) => failed(arm(x, 'B'))).length}/${r.length}`; })(),
  ptFailBAllBoxOfBoxes: (() => { const r = live(all); return `${r.filter((x) => failedBoxOfBoxes(arm(x, 'B'))).length}/${r.length}`; })(),
  ptFailCBoxOfBoxes: (() => { const r = forArm(live(all), 'C'); return `${r.filter((x) => failedBoxOfBoxes(arm(x, 'C'))).length}/${r.length}`; })(),
  ptFailAAll: (() => { const r = live(all); return `${r.filter((x) => failed(arm(x, 'A'))).length}/${r.length}`; })(), ptFailC: `${H3.failC}/${H3.n}`, ptFailD: `${H3.failD}/${H3.n}`,
  ptFixedByC: H3.fixedByC, ptBrokenByC: H3.brokenByC, ptMcnemarP: H3.mcnemarP < 0.001 ? "<0.001" : `=${f(H3.mcnemarP, 3)}`,   // includes the relation (p<0.001 or p=x)
  ptGenC: f(H3.genC, 2), ptGenD: f(H3.genD, 2), ptUnverifiedC: H3.unverifiedC,
  ptSizeImproved: `${H2.improved}/${H2.n}`, ptSizeDiff: f(H2.medianDiff, 1), ptSizeP: f(H2.wilcoxonP, 3),
  ptSeenRecovered: `${H4.seen.recovered}/${H4.seen.n}`, ptSeenPct: pct(H4.seen.recovered, H4.seen.n),
  ptUnseenRecovered: `${H4.unseen.recovered}/${H4.unseen.n}`, ptUnseenPct: pct(H4.unseen.recovered, H4.unseen.n),
  ptStdBMedian: f(P.standard.B.centreMedian), ptStdBMedianCI: `${f(P.standard.B.centreMedianCI[0])}--${f(P.standard.B.centreMedianCI[1])}`,
  ptStdNaiveMedian: f(P.standard.naive.centreMedian),
  ...(() => {
    const T = summary.tests.trust.pooled, out = {};
    for (const [stage, key] of [['first', 'First'], ['final', 'Final']]) {
      const t = T[stage], verified = t.verifiedOk + t.verifiedFail, fails = t.verifiedFail + t.flaggedFail, oks = t.verifiedOk + t.flaggedOk;
      Object.assign(out, {
        [`ptTrust${key}VerOk`]: t.verifiedOk, [`ptTrust${key}VerFail`]: t.verifiedFail, [`ptTrust${key}FlagOk`]: t.flaggedOk, [`ptTrust${key}FlagFail`]: t.flaggedFail,
        [`ptTrust${key}Verified`]: verified, [`ptTrust${key}Precision`]: pct(t.verifiedOk, verified), [`ptTrust${key}Caught`]: `${t.flaggedFail}/${fails}`, [`ptTrust${key}FalseAlarm`]: pct(t.flaggedOk, oks),
      });
    }
    const p = wilson(T.final.verifiedOk, T.final.verifiedOk + T.final.verifiedFail);
    out.ptTrustFinalPrecisionCI = `${Math.round(100 * p[0])}--${Math.round(100 * p[1])}\\,\\%`;
    return out;
  })(),
};
const tex = [
  '% Generated by make-parts-tables.mjs from out/parts/<id>/' + FILE + ' — do not edit.',
  ...Object.entries(macros).map(([k, v]) => `\\newcommand{\\${k}}{${v}}`),
  `\\newcommand{\\ptPartRows}{${rowsPart.join('\n')}}`,
  `\\newcommand{\\ptCondRows}{${rowsCond.join('\n')}}`,
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'results-parts.tex'), tex);
fs.writeFileSync(path.join(PAPER, 'results-parts.tex'), tex);

// pgfplots: failure rate per condition and arm.
fs.writeFileSync(path.join(PAPER, 'plot-failures.dat'), ['cond x A B C D', ...CONDS.map((c, x) => `${c} ${x} ${['A', 'B', 'C', 'D'].map((a) => f(100 * P[c][a].failureRate, 1)).join(' ')}`)].join('\n') + '\n');
console.log(tex);

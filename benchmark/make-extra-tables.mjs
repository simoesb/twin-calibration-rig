// Analysis of E1 (single generation) and E2 (held-out camera), and the pose-block intervals (protocol §9).
// Reads out/parts-extra/{baselines,heldout}/<part>.json, out/parts-extra/pose-block.json (from
// analysis/pose_block.py) and out/parts/<part>/results.json; writes out/parts-extra/summary.json and
// paper-data/results-extra.tex.
//   node make-extra-tables.mjs
import fs from 'node:fs';
import path from 'node:path';
import { OUT, PAPER } from './paths.mjs';

const PARTS = ['pilot-fixture-block', 'pilot-flange-adapter', 'pilot-bearing-housing', 'pilot-sheet-metal-mount'];
const CONDS = ['standard', 'occlusion', 'limited', 'reflective'];
const FOLDS = ['inspection', 'side', 'cell'];
const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const dir = path.join(OUT, 'parts-extra');

// Arms A–D, for side-by-side reporting.
const armRows = PARTS.flatMap((p) => read(path.join(OUT, 'parts', p, 'results.json')).rows.map((r) => ({ ...r, part: p })));
const arms = {};
for (const a of ['A', 'B', 'C', 'D']) {
  arms[a] = { failures: {}, generations: 0 };
  for (const c of CONDS) arms[a].failures[c] = armRows.filter((r) => r.cond === c && r.conditions[a].failed).length;
  arms[a].failures.total = armRows.filter((r) => r.conditions[a].failed).length;
  arms[a].generations = armRows.reduce((s, r) => s + (r.conditions[a].generations ?? 0), 0);
}

// E1: single generation.
const baseRows = PARTS.flatMap((p) => (read(path.join(dir, 'baselines', `${p}.json`))?.rows ?? []).map((r) => ({ ...r, part: p })));
const base = {};
for (const rule of ['largestMask', 'sideOnly']) {
  const rs = baseRows.filter((r) => r.rules);
  const ok = rs.filter((r) => Number.isFinite(r.rules[rule].centreErrMm));
  const fail = (r) => r.rules[rule].failed;
  const cmp = ok.filter((r) => r.rules[rule].stored);
  const dc = cmp.map((r) => Math.abs(r.rules[rule].centreErrMm - r.rules[rule].stored.centreErrMm));
  base[rule] = {
    rows: rs.length, registered: ok.length, notRun: rs.length - ok.length,
    notRunReasons: Object.fromEntries([...new Set(rs.filter((r) => !Number.isFinite(r.rules[rule].centreErrMm)).map((r) => r.rules[rule].reason))].map((k) => [k, rs.filter((r) => r.rules[rule].reason === k).length])),
    views: Object.fromEntries(FOLDS.map((v) => [v, ok.filter((r) => r.rules[rule].view === v).length])),
    failures: { ...Object.fromEntries(CONDS.map((c) => [c, ok.filter((r) => r.cond === c && fail(r)).length])), total: ok.filter(fail).length },
    generations: ok.length,
    reproduction: {
      compared: cmp.length,
      exact: dc.filter((d) => d === 0).length,
      within01mm: dc.filter((d) => d <= 0.1).length,
      maxAbsDiffMm: dc.length ? Math.max(...dc) : null,
      failureLabelDisagreements: cmp.filter((r) => r.rules[rule].failed !== r.rules[rule].stored.failed).length,
    },
    newOutcomes: ok.length - cmp.length,
    failedIds: ok.filter(fail).map((r) => `${r.part}|${r.trial}|${r.cond}`),
  };
}

// E2: held-out camera.
const heldRows = PARTS.flatMap((p) => (read(path.join(dir, 'heldout', `${p}.json`))?.rows ?? []).map((r) => ({ ...r, part: p })));
const spearman = (x, y) => {
  const rank = (v) => { const o = v.map((a, i) => [a, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const rx = rank(x), ry = rank(y), n = x.length, mx = rx.reduce((a, b) => a + b) / n, my = ry.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};
const held = {};
for (const fold of FOLDS) {
  const fs_ = heldRows.filter((r) => r.folds?.[fold]);
  const ran = fs_.filter((r) => Number.isFinite(r.folds[fold].heldIoU));
  const summarize = (rs) => {
    const f = (r) => r.folds[fold];
    const failures = rs.filter((r) => f(r).failed), correct = rs.filter((r) => !f(r).failed);
    return {
      n: rs.length, failures: failures.length, correct: correct.length,
      failuresFlaggedHeldOut: failures.filter((r) => f(r).heldFlag).length,
      correctFlaggedHeldOut: correct.filter((r) => f(r).heldFlag).length,
      failuresFlaggedFitted: failures.filter((r) => !f(r).fittedOk).length,
      correctFlaggedFitted: correct.filter((r) => !f(r).fittedOk).length,
      failuresPassingBoth: failures.filter((r) => f(r).fittedOk && !f(r).heldFlag).length,
      correctPassingBoth: correct.filter((r) => f(r).fittedOk && !f(r).heldFlag).length,
    };
  };
  held[fold] = {
    present: fs_.length, ran: ran.length,
    notRunReasons: Object.fromEntries([...new Set(fs_.filter((r) => !Number.isFinite(r.folds[fold].heldIoU)).map((r) => r.folds[fold].reason))].map((k) => [k, fs_.filter((r) => r.folds[fold].reason === k).length])),
    total: summarize(ran),
    byCondition: Object.fromEntries(CONDS.map((c) => [c, summarize(ran.filter((r) => r.cond === c))])),
    spearmanHeldIoUvsChamfer: ran.length > 2 ? spearman(ran.map((r) => r.folds[fold].heldIoU), ran.map((r) => r.folds[fold].chamferMm)) : null,
    failuresPassingBothIds: ran.filter((r) => r.folds[fold].failed && r.folds[fold].fittedOk && !r.folds[fold].heldFlag).map((r) => `${r.part}|${r.trial}|${r.cond}`),
  };
}

const summary = { protocol: 'protocol/PROTOCOL.md', rows: { baselines: baseRows.length, heldout: heldRows.length }, arms, baselines: base, heldout: held };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

const tex = ['% Generated by make-extra-tables.mjs from out/parts-extra — do not edit.'];
const m = (k, v) => tex.push(`\\newcommand{\\${k}}{${v}}`);
// E1/E2 macros only once every row of a stage exists (10 poses × 4 conditions per part); an incomplete run writes none.
const ROWS = PARTS.length * 40;
if (baseRows.length === ROWS) {
  m('exLMFail', `${base.largestMask.failures.total}/${base.largestMask.registered}`);
  m('exLMGen', base.largestMask.generations);
  m('exSideFail', `${base.sideOnly.failures.total}/${base.sideOnly.registered}`);
  m('exSideGen', base.sideOnly.generations);
  m('exLMFailRefl', base.largestMask.failures.reflective);
  m('exSideFailRefl', base.sideOnly.failures.reflective);
  m('exCFailRefl', arms.C.failures.reflective);
  m('exLMReproduced', `${base.largestMask.reproduction.within01mm}/${base.largestMask.reproduction.compared}`);
}
for (const fold of heldRows.length === ROWS ? FOLDS : []) {
  const t = held[fold].total, K = fold === 'inspection' ? 'Insp' : fold === 'side' ? 'Side' : 'Cell';
  m(`exHo${K}N`, held[fold].ran);
  m(`exHo${K}FailFlag`, `${t.failuresFlaggedHeldOut}/${t.failures}`);
  m(`exHo${K}OkFlag`, `${t.correctFlaggedHeldOut}/${t.correct}`);
  m(`exHo${K}FailPassBoth`, `${t.failuresPassingBoth}/${t.failures}`);
  m(`exHo${K}FitFlag`, `${t.failuresFlaggedFitted}/${t.failures}`);
  m(`exHo${K}Rho`, held[fold].spearmanHeldIoUvsChamfer?.toFixed(2) ?? '--');
}
// Pose-block intervals (analysis/pose_block.py).
const pb = read(path.join(dir, 'pose-block.json'));
if (pb) {
  const pp = (v) => (v * 100).toFixed(0), pp2 = (v) => v.toFixed(2);
  m('exBlockHThreeCI', `${pp(pb.H3_failure_reduction.CI[0])}--${pp(pb.H3_failure_reduction.CI[1])}`);
  m('exBlockHThree', pp(pb.H3_failure_reduction.estimate));
  m('exBlockHTwoCI', `$${pp2(pb.H2_median_diff.CI[0])}$ to $${pp2(pb.H2_median_diff.CI[1])}$`);
  m('exBlockSeenCI', `${pp(pb.H4_seen_rate_CI[0])}--${pp(pb.H4_seen_rate_CI[1])}`);
  m('exBlockHiddenCI', `${pp(pb.H4_hidden_rate_CI[0])}--${pp(pb.H4_hidden_rate_CI[1])}`);
  summary.poseBlock = { source: 'pose-block.json', ...pb };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
}
fs.writeFileSync(path.join(PAPER, 'results-extra.tex'), tex.join('\n') + '\n');
console.log(JSON.stringify({ baselines: { largestMask: base.largestMask.failures, sideOnly: base.sideOnly.failures, repro: base.largestMask.reproduction }, heldout: Object.fromEntries(FOLDS.map((f) => [f, { ran: held[f].ran, ...held[f].total, rho: held[f].spearmanHeldIoUvsChamfer }])) }, null, 1));

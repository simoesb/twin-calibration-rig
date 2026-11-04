// Merges a part's per-condition evaluation files (partbench.html?stage=evaluate&cond=<c>, written
// as out/parts/<id>/results-<cond>.json) into out/parts/<id>/results.json, the file the analysis reads.
// Every condition must be present; rows are ordered by trial, then condition as in the observations.
//   node merge-parts-results.mjs <part-id> [...]
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './paths.mjs';

const CONDS = ['standard', 'occlusion', 'limited', 'reflective'];
for (const id of process.argv.slice(2)) {
  const dir = path.join(OUT, 'parts', id);
  const files = CONDS.map((c) => path.join(dir, `results-${c}.json`));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) { console.error(`${id}: missing ${missing.map((f) => path.basename(f)).join(', ')}`); process.exitCode = 1; continue; }
  const parts = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const order = (r) => r.trial * CONDS.length + CONDS.indexOf(r.cond);
  const rows = parts.flatMap((p) => p.rows).sort((a, b) => order(a) - order(b));
  const { rows: _, ...header } = parts[0];
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...header, mergedFrom: files.map((f) => path.basename(f)), rows }, null, 2));
  console.log(`${id}: ${rows.length} rows merged`);
}

// Reconstructs every generator crop of the multi-part observation sets
// (out/parts/<id>/observations.json) with a Hunyuan3D 2.1 job service.
//
//   HY3D_URL=http://<server>:8081 node recon-parts.mjs [--concurrency 1] [--only standard] [--list crops.json]
//
// The service is deterministic for a given image, so jobs are keyed by the SHA-256 of the crop:
// identical crops (e.g. the side and cell views, which no condition changes) are generated once.
// Outputs: cache/parts-recon/<sha>.glb (untextured, measured), <sha>-textured.glb (figures),
// <sha>.json (settings, crop, timing, status, concurrency); cache/parts-recon/index.json maps
// every crop to its job. Inspection views run first, so the decision-critical inputs finish early.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = (process.env.HY3D_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
import { OUT, CACHE } from './paths.mjs';
const DIR = path.join(CACHE, 'parts-recon');
fs.mkdirSync(DIR, { recursive: true });
const SETTINGS = { steps: 30, octree_resolution: 256, guidance_scale: 5.0, generate_texture: true, seed: 1234 };
const TIMEOUT_S = 600;
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const CONCURRENCY = Number(arg('concurrency', 1));   // the Hunyuan3D service fails concurrent jobs (protocol §10)
const ONLY = arg('only', null);
// --list <file.json>: generate only these crops (an array of crop paths relative to out/).
const LIST = arg('list', null) && new Set(JSON.parse(fs.readFileSync(arg('list'), 'utf8')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collect crops in priority order: inspection views of every condition, then the other views.
const VIEW_ORDER = { inspection: 0, side: 1, cell: 2 };
const COND_ORDER = { standard: 0, occlusion: 1, limited: 2, reflective: 3 };
const crops = [];
for (const id of fs.readdirSync(path.join(OUT, 'parts')).filter((d) => fs.existsSync(path.join(OUT, 'parts', d, 'observations.json')))) {
  const obs = JSON.parse(fs.readFileSync(path.join(OUT, 'parts', id, 'observations.json'), 'utf8'));
  for (const t of obs.trials) for (const [cond, c] of Object.entries(t.conditions)) {
    if (c.skipped || (ONLY && cond !== ONLY)) continue;
    for (const [view, v] of Object.entries(c.views)) if (v.crop) crops.push({ part: id, trial: t.i, cond, view, crop: v.crop });
  }
}
crops.sort((a, b) => VIEW_ORDER[a.view] - VIEW_ORDER[b.view] || COND_ORDER[a.cond] - COND_ORDER[b.cond] || a.part.localeCompare(b.part) || a.trial - b.trial);
const index = fs.existsSync(path.join(DIR, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')) : {};
const jobs = [];
for (const c of crops) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, c.crop))).digest('hex');
  index[c.crop] = sha;
  if (LIST && !LIST.has(c.crop)) continue;
  if (!jobs.some((j) => j.sha === sha)) jobs.push({ sha, crop: c.crop });
}
fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index, null, 2));
const todo = jobs.filter((j) => !fs.existsSync(path.join(DIR, `${j.sha}.json`)));
console.log(`${crops.length} crops, ${jobs.length} unique, ${todo.length} to generate (concurrency ${CONCURRENCY})`);

async function run(job, attempt = 1) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(path.join(OUT, job.crop))], { type: 'image/png' }), 'crop.png');
  Object.entries(SETTINGS).forEach(([k, v]) => form.append(k, String(v)));
  form.append('client_id', `partbench-${job.sha.slice(0, 12)}`);
  form.append('client_version', '1.0.0');
  const t0 = Date.now();
  let status = 'failed', error = null, jobId = null;
  try {
    const sub = await (await fetch(`${URL_}/generate`, { method: 'POST', body: form })).json();
    jobId = sub.job_id;
    if (!jobId) throw new Error(JSON.stringify(sub));
    for (;;) {
      await sleep(3000);
      const s = await (await fetch(`${URL_}/jobs/${jobId}`)).json();
      if (s.status === 'completed' || s.status === 'failed') { status = s.status; error = s.error ?? null; break; }
      if ((Date.now() - t0) / 1000 > TIMEOUT_S) { status = 'timeout'; break; }
    }
    if (status === 'completed') {
      for (const [type, file] of [['white', `${job.sha}.glb`], ['textured', `${job.sha}-textured.glb`]]) {
        const r = await fetch(`${URL_}/download/${jobId}/${type}`);
        if (r.ok) fs.writeFileSync(path.join(DIR, file), Buffer.from(await r.arrayBuffer()));
        else if (type === 'white') { status = 'failed'; error = `download ${r.status}`; }
      }
    }
  } catch (e) { error = e.message; }
  const seconds = (Date.now() - t0) / 1000;
  // A service-side failure (not a timeout) is retried once, as the protocol allows; both attempts are recorded.
  if (status === 'failed' && attempt === 1) { console.log(`${job.sha.slice(0, 12)} failed (${error}); retrying`); return run({ ...job, firstAttempt: { error, seconds } }, 2); }
  fs.writeFileSync(path.join(DIR, `${job.sha}.json`), JSON.stringify({ sha: job.sha, crop: job.crop, settings: SETTINGS, status, error, seconds, job: jobId, attempt, firstAttempt: job.firstAttempt ?? null, concurrency: CONCURRENCY, finishedAt: new Date().toISOString() }, null, 2));
  return { status, seconds };
}

let next = 0, done = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < todo.length) {
    const job = todo[next++];
    const r = await run(job);
    done++;
    const eta = ((Date.now() - t0) / done) * (todo.length - done) / 60000;
    console.log(`[${done}/${todo.length}] ${job.crop} → ${r.status} (${r.seconds.toFixed(0)} s, ETA ${eta.toFixed(0)} min)`);
  }
}));
console.log('done');

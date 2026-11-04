// Sends the benchmark's masked crops (out/trial-<i>-crop<variant>.png) to a Hunyuan3D 2.1
// service and stores the results in cache/<dir>/ (default cache/recon/):
//   trial-<i>.glb            untextured mesh (geometry used by the benchmark)
//   trial-<i>-textured.glb   textured mesh (figures)
//   trial-<i>.json           job settings, timings and status
//
//   HY3D_URL=http://<hunyuan3d-2.1-server>:8081 node recon.mjs [first] [last]
//   environment: SEED (generator seed, default 1234), CROP (crop variant: '' or
//   'noisy' → trial-<i>-crop-noisy.png), RECON_DIR (default 'recon').

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = (process.env.HY3D_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
import { OUT, CACHE } from './paths.mjs';
const RECON = path.join(CACHE, process.env.RECON_DIR ?? 'recon');
const CROP = process.env.CROP ? `-${process.env.CROP}` : '';
fs.mkdirSync(RECON, { recursive: true });
const SETTINGS = { steps: 30, octree_resolution: 256, guidance_scale: 5.0, generate_texture: true, seed: Number(process.env.SEED ?? 1234) };

const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'trials.json'), 'utf8'));
const first = Number(process.argv[2] ?? 0), last = Number(process.argv[3] ?? meta.trials.length - 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const t of meta.trials.filter((t) => t.i >= first && t.i <= last)) {
  const crop = path.join(OUT, `trial-${t.i}-crop${CROP}.png`);
  if (fs.existsSync(path.join(RECON, `trial-${t.i}.glb`))) { console.log(`trial ${t.i}: cached`); continue; }
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(crop)], { type: 'image/png' }), path.basename(crop));
  Object.entries(SETTINGS).forEach(([k, v]) => form.append(k, String(v)));
  form.append('client_id', `paper-bench-${t.i}`);
  form.append('client_version', '1.0.0');
  const t0 = Date.now();
  const sub = await (await fetch(`${URL_}/generate`, { method: 'POST', body: form })).json();
  if (!sub.job_id) throw new Error(`trial ${t.i}: ${JSON.stringify(sub)}`);
  let s;
  for (;;) {
    await sleep(3000);
    s = await (await fetch(`${URL_}/jobs/${sub.job_id}`)).json();
    if (s.status === 'completed' || s.status === 'failed') break;
  }
  const seconds = (Date.now() - t0) / 1000;
  if (s.status !== 'completed') { console.log(`trial ${t.i}: FAILED ${s.error}`); continue; }
  for (const [type, file] of [['white', `trial-${t.i}.glb`], ['textured', `trial-${t.i}-textured.glb`]]) {
    const r = await fetch(`${URL_}/download/${sub.job_id}/${type}`);
    if (r.ok) fs.writeFileSync(path.join(RECON, file), Buffer.from(await r.arrayBuffer()));
  }
  fs.writeFileSync(path.join(RECON, `trial-${t.i}.json`), JSON.stringify({ trial: t.i, settings: SETTINGS, seconds, job: sub.job_id }, null, 2));
  console.log(`trial ${t.i}: ${seconds.toFixed(0)} s`);
}

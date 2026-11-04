// Grounding benchmark with exact ground truth.
//
//   /bench.html?stage=render&n=10   ground-truth trials: the machined bracket at a random
//                                   pose on the inspection plate, rendered from the
//                                   inspection and cell cameras; saves camera images,
//                                   masked crops for the image-to-3D service, and
//                                   out/trials.json.
//   /bench.html?stage=eval          for every reconstruction in cache/recon/trial-<i>.glb:
//                                   register it into the twin under each ablation, then
//                                   measure coverage from the input camera and deviation
//                                   from the ground truth; saves out/results.json.
//   /bench.html?stage=sensitivity   registration under wrong declared size, camera
//                                   calibration and support height; out/sensitivity.json.
//   /bench.html?stage=crops         segmentation-like generator inputs (trial-<i>-crop-noisy.png).
//   /bench.html?stage=holes         blind adjudication sheet for the hole labels.
//   /bench.html?stage=fps           frame time with and without coverage shading.
//   /bench.html?stage=viz&trial=<i> figures for one trial: registration overlay,
//                                   coverage-shaded and deviation-shaded close-ups.
//   /bench.html?stage=beauty&trial=<i> the same close-ups path traced, for print.
//
// Uses the platform's grounding module (lib/grounding.js, bundled from
// pbcVisualization src/scene/grounding).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
  objectMask, registerToSilhouettes, poseModel, computeCoverage, computeDeviation, deviationByCoverage,
  maskCentroidOnPlane, iou, worldBVH, observationAt,
} from '/lib/grounding.js';

const params = new URLSearchParams(location.search);
const stage = params.get('stage');
const log = (s) => { document.getElementById('log').textContent += `${s}\n`; console.log(s); };

/** The bracket's declared overall size (AAS TechnicalData Width, its longest dimension). */
const DECLARED_SIZE = 0.12;
const PLATE = new THREE.Vector3(1.28, 0.83, 0.01);   // inspection plate top centre
const NAIVE_SIZE = 0.15;                              // the platform's fit-to-size default for a dropped draft
/** The reference bracket's mounting holes (local centre on the base's top face), their diameter, and the base thickness. */
const HOLES = [[-0.03, 0.006, 0.003], [0.03, 0.006, 0.003]];
const HOLE_D = 0.007;
const BASE_T = 0.006;

/**
 * Hidden-feature test. For each true mounting hole: was its opening visible to the
 * input camera (occluded by the part itself and the cell)? And what does the
 * registered model have there? Vertical probes look for plate material within one
 * plate thickness of the true base mid-plane:
 *   - `no-plate`   fewer than 75 % of the probes on rings of 6 and 9 mm around the
 *                  hole find material (the base is missing or misplaced there);
 *   - `missing`    the plate is there and so is material at the hole centre;
 *   - `wrong-size` the centre is clear but the opening's diameter (median, over 16
 *                  directions, of the first radius with material) differs by more
 *                  than 50 % from the CAD reference's, probed the same way;
 *   - `recovered`  plate around, centre clear, diameter within ±50 %.
 * Applied to the CAD reference itself, every hole is `recovered`.
 */
function holeFeatures(model, gt, camera) {
  const occ = worldBVH([gt, cell]).bvh;
  const probe = holeProbe(gt);
  const ref = probe(worldBVH(gt).bvh), got = probe(worldBVH(model).bvh);
  return HOLES.map((local, k) => {
    const top = new THREE.Vector3(...local).applyMatrix4(gt.matrixWorld);
    const seen = observationAt(top.clone().add(new THREE.Vector3(0, 1e-4, 0)), new THREE.Vector3(0, 1, 0), [camera], occ, Math.cos(THREE.MathUtils.degToRad(80)), 1e-4) > 0;
    const { plateSupport, centreClear, openingMm } = got[k];
    const outcome = plateSupport < 0.75 ? 'no-plate' : !centreClear ? 'missing'
      : !(Math.abs(openingMm / ref[k].openingMm - 1) <= 0.5) ? 'wrong-size' : 'recovered';
    return { seen, outcome, recovered: outcome === 'recovered', plateSupport, openingMm: Number.isFinite(openingMm) ? openingMm : null, referenceOpeningMm: ref[k].openingMm };
  });
}

/** Vertical probes around each true hole of `gt`, applied to a BVH: plate support, clear centre, opening diameter. */
function holeProbe(gt) {
  const down = new THREE.Vector3(0, -1, 0), up = new THREE.Vector3(0, 0.05, 0);
  const DIRS = Array.from({ length: 16 }, (_, k) => new THREE.Vector3(Math.cos((k * Math.PI) / 8), 0, Math.sin((k * Math.PI) / 8)));
  return (bvh) => HOLES.map((local) => {
    const top = new THREE.Vector3(...local).applyMatrix4(gt.matrixWorld);
    const mid = top.y - BASE_T / 2;
    const material = (p) => bvh.raycast(new THREE.Ray(p.clone().add(up), down), THREE.DoubleSide).some((h) => Math.abs(h.point.y - mid) < BASE_T);
    const at = (dir, r) => top.clone().addScaledVector(dir, r);
    const plateSupport = [0.006, 0.009].flatMap((r) => DIRS.map((d) => material(at(d, r)))).filter(Boolean).length / (2 * DIRS.length);
    const radii = DIRS.map((d) => { for (let r = 0; r <= 2 * HOLE_D; r += 0.00025) if (material(at(d, r))) return r; return Infinity; }).sort((a, b) => a - b);
    return { plateSupport, centreClear: !material(top), openingMm: 1000 * (radii[7] + radii[8]) };
  });
}

// ── Scene ───────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.domElement.addEventListener('webglcontextlost', () => { window.__lost = true; });
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e8ebee');
scene.environmentIntensity = 0.9;
const key = new THREE.DirectionalLight('#fff1e0', 3.0);
key.position.set(2.8, 4.6, 3.4); key.target.position.set(1.2, 0.8, 0);
key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 4; key.shadow.blurSamples = 12;
Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 12 });
scene.add(key, key.target);

const gltf = new GLTFLoader();
const [cellGltf, refGltf, env] = await Promise.all([
  gltf.loadAsync('/assets/democell.glb'), gltf.loadAsync('/assets/bracket-reference.glb'), new HDRLoader().loadAsync('/hdr/empty_warehouse_01_1k.hdr'),
]);
scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(env).texture;
const cell = cellGltf.scene;
cell.traverse((m) => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } });
cell.getObjectByName('Carrier').position.x += 1.6;   // carrier at the end stop
scene.add(cell);
const reference = refGltf.scene;
reference.traverse((m) => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } });

// ── Twin cameras (calibrated: pose + intrinsics are known in the twin) ──────
function twinCamera(name, pos, look, fov, w, h) {
  const c = new THREE.PerspectiveCamera(fov, w / h, 0.02, 20);
  c.name = name; c.position.set(...pos); c.lookAt(...look); c.updateMatrixWorld(true);
  return { camera: c, w, h };
}
const CAMS = {
  inspection: twinCamera('inspection', [PLATE.x, PLATE.y + 0.42, PLATE.z + 0.42], [PLATE.x, PLATE.y + 0.03, PLATE.z], 35, 1024, 1024),
  cell: twinCamera('cell', [2.0, 1.9, 0.9], [PLATE.x, PLATE.y + 0.03, PLATE.z], 40, 1024, 768),
};
/** Same camera at a lower resolution (registration renders at ~256 px). */
const lowRes = ({ camera, w, h }, width = 256) => ({ camera, w: width, h: Math.round((width * h) / w) });

/**
 * Segmentation-like corruption of a mask: random erosion or dilation (1–2 px at
 * 256 px) and boundary jitter (each boundary pixel flipped with probability 0.3).
 */
// With the benchmark's consecutive seeds the generator's first draw barely varies, so
// in practice the amount is constant: 2 px at 256 px for the degraded-mask variant
// (seeds 1000 + i) and 4 px at 1024 px for the noisy crops (seeds 2000 + i), eroded
// or dilated in about half the trials each, before the boundary jitter.
function degradeMask(mask, w, h, rand, scale = 1) {
  const morph = (m, grow) => {
    const out = m.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = y * w + x, n = [m[k - 1], m[k + 1], m[k - w], m[k + w]];
      out[k] = grow ? (m[k] || n.some(Boolean) ? 1 : 0) : (m[k] && n.every(Boolean) ? 1 : 0);
    }
    return out;
  };
  let m = mask;
  const steps = scale * (1 + Math.floor(rand() * 2)), grow = rand() < 0.5;
  for (let i = 0; i < steps; i++) m = morph(m, grow);
  const out = m.slice();
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    const boundary = [m[k - 1], m[k + 1], m[k - w], m[k + w]].some((v) => v !== m[k]);
    if (boundary && rand() < 0.3) out[k] = m[k] ? 0 : 1;
  }
  return out;
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function posedReference(t) {
  const g = reference.clone(true);
  g.position.set(t.pose.x, PLATE.y, t.pose.z);
  g.rotation.set(0, t.pose.yaw, 0);
  g.updateMatrixWorld(true);
  return g;
}

function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
async function savePng(name, canvas) { await fetch(`/save/${name}`, { method: 'POST', body: canvas.toDataURL('image/png') }); }
async function saveJson(name, data) { await fetch(`/save-json/${name}`, { method: 'POST', body: JSON.stringify(data, null, 2) }); }

/** Render the scene from a twin camera into a 2-D canvas. */
function renderRgb({ camera, w, h }) {
  renderer.setSize(w, h, false);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  const c = canvasOf(w, h);
  c.getContext('2d').drawImage(renderer.domElement, 0, 0);
  return c;
}

/** The object on white in a 512² square crop around its mask (1.35× its larger side). */
function maskedCrop(rgb, mask, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k]) { const x = k % w, y = (k / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const side = Math.round(Math.max(x1 - x0, y1 - y0) * 1.35), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const src = rgb.getContext('2d').getImageData(0, 0, w, h);
  for (let k = 0; k < mask.length; k++) if (!mask[k]) { src.data[4 * k] = src.data[4 * k + 1] = src.data[4 * k + 2] = 255; }
  const masked = canvasOf(w, h); masked.getContext('2d').putImageData(src, 0, 0);
  const crop = canvasOf(512, 512);
  const cctx = crop.getContext('2d');
  cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, 512, 512);
  cctx.drawImage(masked, cx - side / 2, cy - side / 2, side, side, 0, 0, 512, 512);
  return crop;
}

// ── Stage: render ground-truth trials ───────────────────────────────────────
async function renderTrials() {
  const n = Number(params.get('n') ?? 10);
  const rand = rng(Number(params.get('seed') ?? 20261005));
  const trials = [];
  for (let i = 0; i < n; i++) {
    const t = { i, pose: { x: PLATE.x + (rand() - 0.5) * 0.12, z: PLATE.z + (rand() - 0.5) * 0.08, yaw: rand() * Math.PI * 2 } };
    const gt = posedReference(t);
    scene.add(gt);
    const rgb = renderRgb(CAMS.inspection);
    await savePng(`trial-${i}-inspection`, rgb);
    await savePng(`trial-${i}-cell`, renderRgb(CAMS.cell));
    scene.remove(gt);

    // Masked, square crop around the object — the image-to-3D service's input.
    const { w, h } = CAMS.inspection;
    const mask = objectMask(renderer, gt, CAMS.inspection.camera, w, h, [cell]);
    await savePng(`trial-${i}-crop`, maskedCrop(rgb, mask, w, h));
    trials.push({ ...t, maskPixels: mask.reduce((s, v) => s + v, 0) });
    log(`trial ${i}: pose ${JSON.stringify(t.pose)} mask ${trials[i].maskPixels}px`);
  }
  const cams = Object.fromEntries(Object.entries(CAMS).map(([k, { camera, w, h }]) => [k, { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, width: w, height: h }]));
  await saveJson('trials', { declaredSize: DECLARED_SIZE, plate: PLATE.toArray(), cameras: cams, trials });
  log('render stage done');
}

// ── Stage: register + evaluate reconstructions ──────────────────────────────
// Exact world-space bounding box (from the vertices): three.js's default box transforms each mesh's local box
// and so inflates with rotation, which made the size error depend on the generator's local frame.
function boxOf(object) { object.updateMatrixWorld(true); return new THREE.Box3().setFromObject(object, true); }

function scoreLocation(placed, gt) {
  const a = boxOf(placed), b = boxOf(gt);
  const ca = a.getCenter(new THREE.Vector3()), cb = b.getCenter(new THREE.Vector3());
  const da = a.getSize(new THREE.Vector3()).length(), db = b.getSize(new THREE.Vector3()).length();
  return { centreErrMm: ca.distanceTo(cb) * 1000, sizeErrPct: (da / db - 1) * 100 };
}

/**
 * ?recon=<dir under cache/> (default recon) evaluates another reconstruction set
 * (other generator seeds, noisy generator inputs) into out/results-<dir>.json;
 * ?set=core runs only the variants those comparisons need.
 */
async function evaluate() {
  const meta = await (await fetch('/out/trials.json')).json();
  const only = params.get('trial');
  const dir = params.get('recon') ?? 'recon';
  const core = params.get('set') === 'core';
  const outName = only !== null ? `results-${dir}-trial-${only}` : dir === 'recon' ? 'results' : `results-${dir}`;
  const results = [];
  for (const t of meta.trials) {
    if (only !== null && String(t.i) !== only) continue;
    const res = await fetch(`/cache/${dir}/trial-${t.i}.glb`, { method: 'HEAD' });
    if (!res.ok) { log(`trial ${t.i}: no reconstruction, skipped`); continue; }
    const recon = (await gltf.loadAsync(`/cache/${dir}/trial-${t.i}.glb`)).scene;
    // The same mesh turned 45° about +Y: the declared-size prior must not care.
    const turned = new THREE.Group();
    const inner = recon.clone(true); inner.rotation.y = Math.PI / 4; turned.add(inner);
    const gt = posedReference(t);
    const views = ['inspection', 'cell'].map((k) => {
      const v = lowRes(CAMS[k]);
      return { camera: v.camera, width: v.w, height: v.h, mask: objectMask(renderer, gt, v.camera, v.w, v.h, [cell]) };
    });

    // Naive drop (what an unsupported placement does): at the mask centroid on the plate, fixed size, no rotation.
    const c0 = maskCentroidOnPlane(views[0], PLATE.y);
    const ext = boxOf(recon).getSize(new THREE.Vector3());
    const naivePose = { position: [c0.x, PLATE.y, c0.z], rotation: [0, 0, 0], scale: NAIVE_SIZE / Math.max(ext.x, ext.y, ext.z) };
    const all = {
      naive: async () => ({ ...naivePose, iou: [iou(objectMask(renderer, poseModel(recon, naivePose), views[0].camera, views[0].width, views[0].height, [cell]), views[0].mask)], evals: 0, ms: 0 }),
      silhouette: () => registerToSilhouettes(renderer, recon, [views[0]], { occluders: [cell], seed: 3 }),
      // 7 DoF with 8 yaw starts and 6.3× the evaluations: optimisation budget vs identifiability.
      silhouetteLong: () => registerToSilhouettes(renderer, recon, [views[0]], { occluders: [cell], seed: 3, yawStarts: Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4), startEvals: 480, refineEvals: 1440 }),
      support: () => registerToSilhouettes(renderer, recon, [views[0]], { supportY: PLATE.y, occluders: [cell], seed: 3 }),
      supportDeclared: () => registerToSilhouettes(renderer, recon, [views[0]], { supportY: PLATE.y, declaredSize: DECLARED_SIZE, occluders: [cell], seed: 3 }),
      supportDeclaredTurned: () => registerToSilhouettes(renderer, turned, [views[0]], { supportY: PLATE.y, declaredSize: DECLARED_SIZE, occluders: [cell], seed: 3 }),
      twoViews: () => registerToSilhouettes(renderer, recon, views, { supportY: PLATE.y, declaredSize: DECLARED_SIZE, occluders: [cell], seed: 3 }),
      twoViewsNoisy: () => {
        const rand = rng(1000 + t.i);
        const noisy = views.map((v) => ({ ...v, mask: degradeMask(v.mask, v.width, v.height, rand) }));
        return registerToSilhouettes(renderer, recon, noisy, { supportY: PLATE.y, declaredSize: DECLARED_SIZE, occluders: [cell], seed: 3 });
      },
    };
    const CORE = ['naive', 'support', 'supportDeclared', 'twoViews'];
    const variants = Object.fromEntries(Object.entries(all).filter(([k]) => !core || CORE.includes(k)));
    const row = { i: t.i, variants: {} };
    for (const [name, run] of Object.entries(variants)) {
      const r = await run();
      const placed = poseModel(name === 'supportDeclaredTurned' ? turned : recon, r);
      const dev = computeDeviation(placed, gt, 6000);
      row.variants[name] = {
        ...scoreLocation(placed, gt), iou: r.iou, evals: r.evals, ms: Math.round(r.ms), scale: r.scale, pose: { position: r.position, rotation: r.rotation, scale: r.scale },
        chamferMm: dev.chamfer * 1000, hausdorffMm: dev.hausdorff * 1000, forwardP95Mm: dev.forward.p95 * 1000, backwardP95Mm: dev.backward.p95 * 1000,
      };
      // Single-view fits: how well does the solution explain the camera it never saw?
      if (name === 'supportDeclared' || name === 'support') {
        row.variants[name].heldOutIoU = iou(objectMask(renderer, placed, views[1].camera, views[1].width, views[1].height, [cell]), views[1].mask);
      }
      if (name === 'twoViews') {
        let tc = performance.now();
        const cov = computeCoverage(placed, [CAMS.inspection.camera], { occluders: [cell], samples: 12000 });
        const coverageMs = performance.now() - tc;
        tc = performance.now();
        computeDeviation(placed, gt, 12000);
        const deviationMs = performance.now() - tc;
        const split = deviationByCoverage(placed, gt, [CAMS.inspection.camera], { occluders: [cell], samples: 12000 });
        let triangles = 0;
        placed.traverse((m) => { if (m.isMesh) triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
        row.coverage = { fraction: cov.fraction, observed: scaleStats(split.observed), inferred: scaleStats(split.inferred) };
        row.timing = { coverageMs: Math.round(coverageMs), deviationMs: Math.round(deviationMs), triangles };
        row.holes = holeFeatures(placed, gt, CAMS.inspection.camera);
        if (!core) row.scaleFamily = scaleFamily(recon, r, views);
      }
      log(`trial ${t.i} ${name}: centre ${row.variants[name].centreErrMm.toFixed(1)} mm, size ${row.variants[name].sizeErrPct.toFixed(1)} %, chamfer ${row.variants[name].chamferMm.toFixed(2)} mm, IoU ${r.iou.map((v) => v.toFixed(3)).join('/')}, ${Math.round(r.ms)} ms`);
    }
    if (row.holes) log(`trial ${t.i} holes ${row.holes.map((h) => `${h.seen ? 'seen' : 'unseen'}→${h.outcome} (plate ${(h.plateSupport * 100).toFixed(0)} %, Ø ${h.openingMm?.toFixed(1) ?? '–'} mm)`).join(', ')}`);
    if (row.coverage) log(`trial ${t.i} coverage ${(row.coverage.fraction * 100).toFixed(1)} %; |dev| observed ${row.coverage.observed.mean.toFixed(2)} mm vs inferred ${row.coverage.inferred.mean.toFixed(2)} mm`);
    results.push(row);
    await saveJson(outName, { declaredSize: DECLARED_SIZE, recon: dir, results, referenceHoles: holeFeatures(posedReference(meta.trials[0]), posedReference(meta.trials[0]), CAMS.inspection.camera) });
  }
  log('eval stage done');
  window.__done = true;
}
/**
 * The exact scale–depth ambiguity of a silhouette: scaling the registered model by k
 * about the inspection camera's centre leaves its inspection image unchanged (up to
 * occlusion by the cell), while it lifts off or sinks into the support and changes
 * the second camera's view. Returns both IoUs and the height of the model's base
 * above the support along that family.
 */
function scaleFamily(recon, pose, views) {
  const C = views[0].camera.position;
  const ks = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];
  const rows = ks.map((k) => {
    const p = new THREE.Vector3(...pose.position).sub(C).multiplyScalar(k).add(C);
    const placed = poseModel(recon, { position: p.toArray(), rotation: pose.rotation, scale: pose.scale * k });
    const [a, b] = views.map((v) => iou(objectMask(renderer, placed, v.camera, v.width, v.height, [cell]), v.mask));
    return { k, iouInspection: a, iouCell: b, baseAboveSupportMm: (p.y - PLATE.y) * 1000 };
  });
  return rows;
}

const scaleStats = (s) => ({ mean: s.mean * 1000, rms: s.rms * 1000, p95: s.p95 * 1000, max: s.max * 1000, fraction: s.fraction });

// ── Stage: figures for one trial ────────────────────────────────────────────
/** Outline of a binary mask, drawn into a 2-D context at `scale`. */
function drawOutline(ctx, mask, w, h, color, scale, width = 3) {
  ctx.fillStyle = color;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    if (mask[k] && (!mask[k - 1] || !mask[k + 1] || !mask[k - w] || !mask[k + w])) ctx.fillRect(x * scale - width / 2, y * scale - width / 2, width, width);
  }
}

async function figures() {
  const meta = await (await fetch('/out/trials.json')).json();
  const t = meta.trials[Number(params.get('trial') ?? 0)];
  const { applyCoverageShading, applyDeviationShading, meshesOf } = await import('/lib/grounding.js');
  const recon = (await gltf.loadAsync(`/cache/recon/trial-${t.i}.glb`)).scene;
  const gt = posedReference(t);
  const views = ['inspection', 'cell'].map((k) => { const v = lowRes(CAMS[k]); return { camera: v.camera, width: v.w, height: v.h, mask: objectMask(renderer, gt, v.camera, v.w, v.h, [cell]) }; });
  const r = await registerToSilhouettes(renderer, recon, views, { supportY: PLATE.y, declaredSize: DECLARED_SIZE, occluders: [cell], seed: 3 });
  const placed = poseModel(recon, r);

  // (a) Registration overlay on the inspection image: ground-truth mask vs registered silhouette.
  const { w, h } = CAMS.inspection;
  const img = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = `/out/trial-${t.i}-inspection.png`; });
  const a = canvasOf(w, h), actx = a.getContext('2d');
  actx.drawImage(img, 0, 0);
  actx.fillStyle = 'rgba(255,255,255,0.35)'; actx.fillRect(0, 0, w, h);
  drawOutline(actx, objectMask(renderer, gt, CAMS.inspection.camera, w, h, [cell]), w, h, '#1d2329', 1, 3);
  drawOutline(actx, objectMask(renderer, placed, CAMS.inspection.camera, w, h, [cell]), w, h, '#14a37f', 1, 4);
  await savePng(`fig-trial-${t.i}-registration`, a);
  // Tight 4:3 crop around the part for figures.
  const gtMask = objectMask(renderer, gt, CAMS.inspection.camera, w, h, [cell]);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let k = 0; k < gtMask.length; k++) if (gtMask[k]) { const x = k % w, y = (k / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cw = Math.max(x1 - x0, ((y1 - y0) * 4) / 3) * 1.5, ch = (cw * 3) / 4;
  const crop = canvasOf(1200, 900);
  crop.getContext('2d').drawImage(a, (x0 + x1) / 2 - cw / 2, (y0 + y1) / 2 - ch / 2, cw, ch, 0, 0, 1200, 900);
  await savePng(`fig-trial-${t.i}-registration-crop`, crop);

  // Close-up camera on the plate.
  // Viewpoint offset from the plate (?view=dx,dy,dz); default from the front-left.
  const [dx, dy, dz] = (params.get('view') ?? '-0.32,0.26,0.3').split(',').map(Number);
  const close = twinCamera('close', [PLATE.x + dx, PLATE.y + dy, PLATE.z + dz], [t.pose.x, PLATE.y + 0.035, t.pose.z], 30, 1600, 1200);
  const tag = params.get('tag') ? `-${params.get('tag')}` : '';
  const shadeAndRender = async (name, shade) => {
    const copy = placed.clone(true);
    copy.traverse((m) => { if (m.isMesh) { m.geometry = m.geometry.clone(); m.castShadow = true; m.receiveShadow = true; } });
    shade(copy);
    scene.add(copy);
    await savePng(name, renderRgb(close));
    scene.remove(copy);
  };
  // (b) Coverage: what the inspection camera saw vs what the generator inferred.
  const cov = computeCoverage(placed, [CAMS.inspection.camera], { occluders: [cell], samples: 12000 });
  const covByIndex = [...cov.perMesh.values()];
  await shadeAndRender(`fig-trial-${t.i}-coverage${tag}`, (copy) => meshesOf(copy).forEach((m, k) => applyCoverageShading(m, covByIndex[k], { spacing: 9, observedTint: '#9fe0c8' })));
  // (c) Deviation from the ground truth (±3 mm).
  const dev = computeDeviation(placed, gt, 6000);
  const devByIndex = [...dev.perMesh.values()];
  await shadeAndRender(`fig-trial-${t.i}-deviation${tag}`, (copy) => meshesOf(copy).forEach((m, k) => applyDeviationShading(m, devByIndex[k], 0.003)));
  // Ground truth from the same viewpoint, for comparison.
  scene.add(gt); await savePng(`fig-trial-${t.i}-groundtruth${tag}`, renderRgb(close)); scene.remove(gt);
  await saveJson(`fig-trial-${t.i}${tag}`, { registration: { ...r, ms: Math.round(r.ms) }, coverage: cov.fraction, chamferMm: dev.chamfer * 1000 });
  log(`figures for trial ${t.i} saved`);
}

// ── Stage: path-traced close-ups for print ──────────────────────────────────
/**
 * The viz close-ups rendered with three-gpu-pathtracer: area-lit, image-based
 * lighting with interreflections and depth of field. Deviation is carried by vertex
 * colours; coverage colours observed/inferred surfaces per vertex and composites the
 * platform's screen-space hatch from a rasterized inferred-surface mask, so the
 * evidence encoding matches the live renderer.
 *   ?stage=beauty&trial=<i>&pass=coverage|deviation|groundtruth[&view=dx,dy,dz][&tag=..][&w=1600][&spp=800][&fstop=5.6]
 */
async function beauty() {
  const { WebGLPathTracer, PhysicalCamera } = await import('three-gpu-pathtracer');
  const { applyDeviationShading, meshesOf } = await import('/lib/grounding.js');
  const meta = await (await fetch('/out/trials.json')).json();
  const t = meta.trials[Number(params.get('trial') ?? 0)];
  const recon = (await gltf.loadAsync(`/cache/recon/trial-${t.i}.glb`)).scene;
  const gt = posedReference(t);
  const views = ['inspection', 'cell'].map((k) => { const v = lowRes(CAMS[k]); return { camera: v.camera, width: v.w, height: v.h, mask: objectMask(renderer, gt, v.camera, v.w, v.h, [cell]) }; });
  const r = await registerToSilhouettes(renderer, recon, views, { supportY: PLATE.y, declaredSize: DECLARED_SIZE, occluders: [cell], seed: 3 });
  const placed = poseModel(recon, r);

  const W = Number(params.get('w') ?? 1600), H = Math.round((W * 3) / 4);
  const spp = Number(params.get('spp') ?? 800);
  // Long traces lose the WebGL context, so a figure is traced in chunks (?chunk=k, one
  // page load each, decorrelated by a seed offset) and averaged by ?stage=average.
  const chunk = params.get('chunk');
  const tag = (params.get('tag') ? `-${params.get('tag')}` : '') + (chunk !== null ? `-c${chunk}` : '');
  const [dx, dy, dz] = (params.get('view') ?? '-0.32,0.26,0.3').split(',').map(Number);
  const target = new THREE.Vector3(t.pose.x, PLATE.y + 0.035, t.pose.z);
  const camera = new PhysicalCamera(30, W / H, 0.02, 20);
  camera.position.set(PLATE.x + dx, PLATE.y + dy, PLATE.z + dz);
  camera.lookAt(target);
  camera.focusDistance = camera.position.distanceTo(target);
  camera.fStop = Number(params.get('fstop') ?? 5.6);
  camera.apertureBlades = 7;
  camera.updateMatrixWorld(true);

  // Lighting for the path tracer: the raw equirect environment and a soft area key
  // in place of the shadow-mapped sun.
  const pmrem = scene.environment;
  env.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = env;
  scene.remove(key, key.target);
  const softbox = new THREE.RectAreaLight('#fff4e6', Number(params.get('key') ?? 9), 0.9, 0.9);
  softbox.position.set(PLATE.x + 0.9, PLATE.y + 1.4, PLATE.z + 1.0);
  softbox.lookAt(target);
  scene.add(softbox);

  renderer.setSize(W, H, false);
  const pt = new WebGLPathTracer(renderer);
  Object.assign(pt, { renderDelay: 0, fadeDuration: 0, minSamples: 0, bounces: 6, filterGlossyFactor: 1, rasterizeScene: false });
  pt.tiles.set(4, 4);   // short dispatches: long ones trip the GPU watchdog
  // Yield through a message rather than a timer: browsers throttle timers in hidden pages
  // to as little as once a minute, which would stall the trace.
  const tick = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });

  const trace = async (objects) => {
    objects.forEach((o) => scene.add(o));
    renderer.setSize(W, H, false);
    pt.setScene(scene, camera);
    while (pt.isCompiling) await tick();
    let k = 0;
    pt.renderSample();
    pt._pathTracer.material.seed += Number(chunk ?? 0) * spp * 7919;
    const gl = renderer.getContext();
    while (pt.samples < spp && !gl.isContextLost()) { pt.renderSample(); if (++k % 8 === 0) await tick(); }
    const c = canvasOf(W, H);
    c.getContext('2d').drawImage(renderer.domElement, 0, 0);
    if (gl.isContextLost() || isUniform(c)) { window.__lost = true; throw new Error('WebGL context lost'); }
    objects.forEach((o) => scene.remove(o));
    return c;
  };
  const shadedCopy = (shade) => {
    const copy = placed.clone(true);
    copy.traverse((m) => { if (m.isMesh) { m.geometry = m.geometry.clone(); m.castShadow = m.receiveShadow = true; } });
    shade(copy);
    // RGBA vertex colours: the path tracer's RGB→RGBA conversion copies the wrong way.
    copy.traverse((m) => {
      const c = m.isMesh && m.geometry.attributes.color;
      if (!c || c.itemSize === 4) return;
      const rgba = new Float32Array(c.count * 4).fill(1);
      for (let i = 0; i < c.count; i++) rgba.set([c.getX(i), c.getY(i), c.getZ(i)], 4 * i);
      m.geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    });
    return copy;
  };

  // One pass per page load (?pass=coverage|deviation|groundtruth): rebuilding the
  // path-tracing scene repeatedly in one page exhausts GPU memory.
  const pass = params.get('pass') ?? 'coverage';
  if (pass === 'coverage') {
  // Coverage: observed surfaces mint, inferred surfaces neutral, then the hatch.
  const cov = computeCoverage(placed, [CAMS.inspection.camera], { occluders: [cell], samples: 12000 });
  const quality = [...cov.perMesh.values()];
  const observedC = new THREE.Color('#9fd8c2'), inferredC = new THREE.Color('#d8d4cf');
  const covCopy = shadedCopy((copy) => meshesOf(copy).forEach((m, k) => {
    const q = quality[k], colors = new Float32Array(q.length * 3);
    q.forEach((v, i) => (v > 0 ? observedC : inferredC).toArray(colors, 3 * i));
    m.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    m.geometry.setAttribute('observation', new THREE.BufferAttribute(q, 1));
    m.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide });
  }));
  const covImg = await trace([covCopy]);
  if (window.__lost) throw new Error('WebGL context lost');
  compositeHatch(covImg, inferredMask(covCopy, camera, W, H), (W / 1600) * (16 / 9));
  await savePng(`fig-trial-${t.i}-coverage-pt${tag}`, covImg);
  log('coverage traced');
  } else if (pass === 'deviation') {
  const dev = computeDeviation(placed, gt, 6000);
  const devByIndex = [...dev.perMesh.values()];
  await savePng(`fig-trial-${t.i}-deviation-pt${tag}`, await trace([shadedCopy((copy) => meshesOf(copy).forEach((m, k) => applyDeviationShading(m, devByIndex[k], 0.003)))]));
  log('deviation traced');
  } else {
  await savePng(`fig-trial-${t.i}-groundtruth-pt${tag}`, await trace([gt]));
  log('ground truth traced');
  }

  scene.remove(softbox);
  scene.add(key, key.target);
  scene.environment = pmrem;
  log(`path-traced figures for trial ${t.i} saved (${spp} spp)`);
}

/** True when a canvas is a single flat colour (what a lost context leaves behind). */
function isUniform(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 4; i < d.length; i += 4 * 97) if (Math.abs(d[i] - d[0]) > 2 || Math.abs(d[i + 1] - d[1]) > 2) return false;
  return true;
}

/** Rasterized mask (supersampled 2×) of the inferred surface of `object` as seen from `camera`, occluded by the scene. */
function inferredMask(object, camera, W, H) {
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const maskMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'attribute float observation; varying float vObs; void main() { vObs = observation; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float vObs; void main() { gl_FragColor = vec4(vec3(1.0 - smoothstep(0.0, 0.05, vObs)), 1.0); }',
  });
  const saved = new Map();
  scene.add(object);
  scene.traverse((m) => { if (m.isMesh) { saved.set(m, m.material); m.material = black; } });
  object.traverse((m) => { if (m.isMesh) m.material = maskMat; });
  const bg = scene.background, tm = renderer.toneMapping;
  scene.background = new THREE.Color(0x000000); renderer.toneMapping = THREE.NoToneMapping;
  renderer.setSize(W * 2, H * 2, false);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  const c = canvasOf(W, H);
  c.getContext('2d').drawImage(renderer.domElement, 0, 0, W * 2, H * 2, 0, 0, W, H);
  saved.forEach((mat, m) => { m.material = mat; });
  scene.remove(object);
  scene.background = bg; renderer.toneMapping = tm;
  renderer.setSize(W, H, false);
  return c.getContext('2d').getImageData(0, 0, W, H).data;
}

/** The platform's coverage hatch (diagonal stripes, `#d0662f`), anti-aliased, shaded by the traced luminance. */
function compositeHatch(canvas, mask, scale = 1) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data, w = canvas.width;
  const spacing = 9 * scale, hatch = [0xd0, 0x66, 0x2f];
  const sub = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  for (let k = 0; k < d.length / 4; k++) {
    const m = mask[4 * k] / 255;
    if (m <= 0) continue;
    const x = k % w, y = (k / w) | 0;
    const stripe = sub.reduce((s, [ox, oy]) => s + (((x + ox + y + oy) / spacing) % 1 >= 0.62 ? 1 : 0), 0) / sub.length;
    const a = stripe * 0.75 * m;
    if (a <= 0) continue;
    const luma = (0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2]) / 255;
    const shade = Math.min(1.08, Math.max(0.4, luma / 0.8));
    for (let c = 0; c < 3; c++) d[4 * k + c] = d[4 * k + c] * (1 - a) + hatch[c] * shade * a;
  }
  ctx.putImageData(img, 0, 0);
}

// ── Stage: average traced chunks ────────────────────────────────────────────
/** ?stage=average&name=<figure name without -c<k>>&n=<chunks>: mean in linear light. */
async function averageChunks() {
  const name = params.get('name'), n = Number(params.get('n') ?? 4);
  const imgs = await Promise.all([...Array(n).keys()].map((k) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = `/out/${name}-c${k}.png`; })));
  const w = imgs[0].width, h = imgs[0].height;
  const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const toSrgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const lut = Float32Array.from({ length: 256 }, (_, v) => toLin(v));
  const acc = new Float32Array(w * h * 4);
  for (const im of imgs) {
    const c = canvasOf(w, h), ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i++) acc[i] += (i % 4 === 3 ? d[i] / 255 : lut[d[i]]) / n;
  }
  const out = canvasOf(w, h), octx = out.getContext('2d'), img = octx.createImageData(w, h);
  for (let i = 0; i < acc.length; i++) img.data[i] = i % 4 === 3 ? 255 : Math.round(toSrgb(acc[i]));
  octx.putImageData(img, 0, 0);
  await savePng(name, out);
  log(`averaged ${n} chunks into ${name}`);
}

// ── Stage: sensitivity to wrong priors and calibration ──────────────────────
/** Unit vector, uniform on the sphere. */
function randomUnit(rand) {
  const z = 2 * rand() - 1, phi = 2 * Math.PI * rand(), r = Math.sqrt(1 - z * z);
  return new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z);
}

/**
 * Two-camera registration when what the twin believes is wrong: declared size off
 * by a factor, each camera's believed pose rotated (random axis) or shifted (random
 * direction), or the support surface believed higher or lower. Masks always come
 * from the true cameras. Saves out/sensitivity.json.
 */
async function sensitivity() {
  const meta = await (await fetch('/out/trials.json')).json();
  const conditions = [
    { kind: 'none', value: 0 },
    ...[0.8, 0.9, 0.95, 1.05, 1.1, 1.2].map((value) => ({ kind: 'declaredSize', value })),
    ...[0.25, 0.5, 1].map((value) => ({ kind: 'cameraRotDeg', value })),
    ...[2, 5, 10].map((value) => ({ kind: 'cameraShiftMm', value })),
    ...[-5, -2, 2, 5].map((value) => ({ kind: 'supportMm', value })),
  ];
  // ?trials=a-b runs a range in parallel tabs, saved as sensitivity-a-b.json and merged by make-tables.mjs.
  const range = params.get('trials')?.split('-').map(Number);
  const outName = range ? `sensitivity-${range[0]}-${range[1]}` : 'sensitivity';
  const results = [];
  for (const t of meta.trials.filter((x) => !range || (x.i >= range[0] && x.i <= range[1]))) {
    const recon = (await gltf.loadAsync(`/cache/recon/trial-${t.i}.glb`)).scene;
    const gt = posedReference(t);
    const views = ['inspection', 'cell'].map((k) => { const v = lowRes(CAMS[k]); return { camera: v.camera, width: v.w, height: v.h, mask: objectMask(renderer, gt, v.camera, v.w, v.h, [cell]) }; });
    for (const [ci, c] of conditions.entries()) {
      const rand = rng(5000 + 31 * t.i + ci);
      const believed = views.map((v) => {
        const camera = v.camera.clone();
        if (c.kind === 'cameraRotDeg') camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(randomUnit(rand), THREE.MathUtils.degToRad(c.value)));
        if (c.kind === 'cameraShiftMm') camera.position.addScaledVector(randomUnit(rand), c.value / 1000);
        camera.updateMatrixWorld(true);
        return { ...v, camera };
      });
      const r = await registerToSilhouettes(renderer, recon, believed, {
        supportY: PLATE.y + (c.kind === 'supportMm' ? c.value / 1000 : 0),
        declaredSize: DECLARED_SIZE * (c.kind === 'declaredSize' ? c.value : 1),
        occluders: [cell], seed: 3,
      });
      const placed = poseModel(recon, r);
      const dev = computeDeviation(placed, gt, 6000);
      results.push({ i: t.i, ...c, ...scoreLocation(placed, gt), chamferMm: dev.chamfer * 1000, iou: r.iou });
    }
    log(`trial ${t.i}: ${conditions.length} conditions`);
    await saveJson(outName, { conditions, results });
  }
  log('sensitivity stage done');
}

// ── Stage: imperfect generator inputs ───────────────────────────────────────
/**
 * The generator's crop from a segmentation-like mask instead of the exact one: the
 * degraded-mask corruption at full resolution (erosion or dilation at 1024 px, so
 * dilation lets background into the crop, plus boundary jitter; see degradeMask).
 * Saves out/trial-<i>-crop-noisy.png for recon.mjs (CROP=noisy).
 */
async function noisyCrops() {
  const meta = await (await fetch('/out/trials.json')).json();
  const { w, h } = CAMS.inspection;
  for (const t of meta.trials) {
    const gt = posedReference(t);
    const rgb = await new Promise((res) => { const im = new Image(); im.onload = () => { const c = canvasOf(w, h); c.getContext('2d').drawImage(im, 0, 0); res(c); }; im.src = `/out/trial-${t.i}-inspection.png`; });
    const mask = degradeMask(objectMask(renderer, gt, CAMS.inspection.camera, w, h, [cell]), w, h, rng(2000 + t.i), 4);
    await savePng(`trial-${t.i}-crop-noisy`, maskedCrop(rgb, mask, w, h));
    log(`trial ${t.i}: noisy crop`);
  }
  log('noisy crops done');
}

// ── Stage: blind adjudication sheet for the hole labels ─────────────────────
/**
 * Top-down silhouettes (dark part on a light background, so openings show light)
 * of every mounting-hole location on the registered
 * reconstructions (two-camera registration, from out/results.json), in a shuffled
 * order with no visibility or label information, so the automatic hole labels can
 * be checked by people who do not know which holes the camera saw. Saves
 * out/holes-sheet.png, out/holes-key.json (tile → trial, hole, automatic label) and
 * out/holes-adjudication.json (to fill in: present / absent / unclear).
 */
async function holeSheet() {
  const meta = await (await fetch('/out/trials.json')).json();
  const { results } = await (await fetch('/out/results.json')).json();
  const tiles = [];
  for (const row of results) {
    const t = meta.trials.find((x) => x.i === row.i);
    const recon = (await gltf.loadAsync(`/cache/recon/trial-${t.i}.glb`)).scene;
    const placed = poseModel(recon, row.variants.twoViews.pose);
    const gt = posedReference(t);
    HOLES.forEach((local, k) => tiles.push({ trial: t.i, hole: k, at: new THREE.Vector3(...local).applyMatrix4(gt.matrixWorld), placed, auto: row.holes[k] }));
  }
  const rand = rng(77);
  for (let k = tiles.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [tiles[k], tiles[j]] = [tiles[j], tiles[k]]; }
  const S = 240, COLS = 8, half = 0.015;
  const sheet = canvasOf(COLS * S, Math.ceil(tiles.length / COLS) * S);
  const sctx = sheet.getContext('2d');
  const sheetScene = new THREE.Scene();
  sheetScene.background = new THREE.Color('#f4f4f4');
  const grey = new THREE.MeshBasicMaterial({ color: '#2a2f35', side: THREE.DoubleSide });
  const tm = renderer.toneMapping;
  for (const [n, tile] of tiles.entries()) {
    const copy = tile.placed.clone(true);
    copy.traverse((m) => { if (m.isMesh) m.material = grey; });
    sheetScene.add(copy);
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.001, 1);
    cam.position.set(tile.at.x, tile.at.y + 0.2, tile.at.z); cam.up.set(0, 0, -1); cam.lookAt(tile.at);
    renderer.setSize(S, S, false); renderer.setRenderTarget(null);
    renderer.render(sheetScene, cam);
    sheetScene.remove(copy);
    const x = (n % COLS) * S, y = Math.floor(n / COLS) * S;
    sctx.drawImage(renderer.domElement, 0, 0, S, S, x, y, S, S);
    // Where the hole should be (a 7 mm circle) and the tile number.
    sctx.strokeStyle = '#d0662f'; sctx.lineWidth = 2;
    sctx.beginPath(); sctx.arc(x + S / 2, y + S / 2, (HOLE_D / 2 / (2 * half)) * S, 0, 2 * Math.PI); sctx.stroke();
    sctx.fillStyle = '#e8ebee'; sctx.font = 'bold 18px system-ui'; sctx.fillText(String(n + 1), x + 8, y + 24);
  }
  renderer.toneMapping = tm;
  await savePng('holes-sheet', sheet);
  const key = tiles.map((tile, n) => ({ tile: n + 1, trial: tile.trial, hole: tile.hole, seen: tile.auto.seen, auto: tile.auto.outcome }));
  await saveJson('holes-key', key);
  await saveJson('holes-adjudication', key.map((k) => ({ tile: k.tile, label: '' })));
  log(`hole sheet: ${tiles.length} tiles`);
}

// ── Stage: frame time with and without evidence shading ─────────────────────
async function frameTimes() {
  const meta = await (await fetch('/out/trials.json')).json();
  const t = meta.trials[0];
  const { applyCoverageShading, meshesOf } = await import('/lib/grounding.js');
  const recon = (await gltf.loadAsync(`/cache/recon/trial-${t.i}.glb`)).scene;
  const pose = { position: [PLATE.x, PLATE.y, PLATE.z], rotation: [0, t.pose.yaw, 0], scale: DECLARED_SIZE / Math.max(...boxOf(recon).getSize(new THREE.Vector3()).toArray()) };
  const view = twinCamera('fps', [-2.9, 2.3, 3.9], [0.45, 0.45, 0], 30, 1920, 1080);
  renderer.setSize(view.w, view.h, false);
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  const time = (frames) => {
    for (let k = 0; k < 10; k++) renderer.render(scene, view.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let k = 0; k < frames; k++) { renderer.render(scene, view.camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return (performance.now() - t0) / frames;
  };
  const plain = poseModel(recon, pose);
  const shaded = poseModel(recon, pose);
  const cov = computeCoverage(shaded, [CAMS.inspection.camera], { occluders: [cell], samples: 2000 });
  const q = [...cov.perMesh.values()];
  meshesOf(shaded).forEach((m, k) => applyCoverageShading(m, q[k]));
  // Ten repetitions of 120 frames each, alternating which condition runs first.
  const plainRuns = [], shadedRuns = [];
  const run = (model, into) => { scene.add(model); into.push(time(120)); scene.remove(model); };
  for (let r = 0; r < 10; r++) {
    if (r % 2 === 0) { run(plain, plainRuns); run(shaded, shadedRuns); } else { run(shaded, shadedRuns); run(plain, plainRuns); }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
  const diffs = plainRuns.map((p, k) => shadedRuns[k] - p);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  await saveJson('frametimes', {
    resolution: [view.w, view.h], framesPerRun: 120, runs: 10, plainRuns, shadedRuns,
    plainMs: mean(plainRuns), plainSd: sd(plainRuns), shadedMs: mean(shadedRuns), shadedSd: sd(shadedRuns), diffMs: mean(diffs), diffSd: sd(diffs),
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), userAgent: navigator.userAgent,
  });
  log(`frame time 1920x1080 (10 × 120 frames): plain ${mean(plainRuns).toFixed(2)} ± ${sd(plainRuns).toFixed(2)} ms, shaded ${mean(shadedRuns).toFixed(2)} ± ${sd(shadedRuns).toFixed(2)} ms`);
}

const STAGES = { render: renderTrials, eval: evaluate, sensitivity, crops: noisyCrops, holes: holeSheet, fps: frameTimes, viz: figures, beauty, average: averageChunks };
try {
  if (!STAGES[stage]) throw new Error(`unknown stage "${stage}" (${Object.keys(STAGES).join(', ')})`);
  await STAGES[stage]();
  window.__done = true;
} catch (e) {
  log(`Error: ${e.message}`);
  window.__failed = true;
}
// Tell a hosting page (driver.html) without making it poll: hidden pages' timers are throttled.
if (window.parent !== window) window.parent.postMessage({ bench: window.__done && !window.__lost ? 'done' : 'failed' }, '*');

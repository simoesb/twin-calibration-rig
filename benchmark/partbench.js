// Multi-part grounding benchmark: the four held-out reference parts in parts/ (protocol/PROTOCOL.md).
// The bracket benchmark is bench.js; this harness loads each part's geometry,
// declared dimensions and feature inventory from its folder.
//
//   /partbench.html?stage=observe[&part=<id>][&n=10]   calibrated observation sets: random poses on
//                                    the inspection plate, rendered from three twin cameras under four
//                                    conditions (standard, occlusion, limited view, reflective finish);
//                                    RGB images, generator crops, and out/parts/<id>/observations.json.
//   /partbench.html?stage=preview    one standard view per part, to check camera placement.
//
// Coordinates: three.js world, metres, +Y up. Part GLBs are metric, +Y up, resting base at y = 0
// (CAD mm, Z up → GLB [x, z, −y] / 1000). Feature centres and axes in part.json are CAD; see cadToGlb.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
  objectMask, registerToSilhouettes, poseModel, computeCoverage, computeDeviation, worldBVH, observationAt,
  maskCentroidOnPlane, iou, longestDimension, groundWithVerification,
} from '/lib/grounding.js';

const params = new URLSearchParams(location.search);
const stage = params.get('stage');
const log = (s) => { document.getElementById('log').textContent += `${s}\n`; console.log(s); };

export const PARTS = ['pilot-fixture-block', 'pilot-flange-adapter', 'pilot-bearing-housing', 'pilot-sheet-metal-mount'];
const PLATE = new THREE.Vector3(1.28, 0.83, 0.01);              // inspection plate top centre
const PLATE_RANGE = { x: 0.03, z: 0.02 };                        // pose offsets keep every part on the 280 × 220 mm plate
const ENV = { hdr: 'empty_warehouse_01_1k.hdr', intensity: 0.9, background: '#e8ebee' };
const KEY = { color: '#fff1e0', intensity: 3.0, position: [2.8, 4.6, 3.4], target: [1.2, 0.8, 0] };
const CONDITIONS = ['standard', 'occlusion', 'limited', 'reflective'];
const VIEWS = ['inspection', 'side', 'cell'];

// ── Scene ───────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(ENV.background);
scene.environmentIntensity = ENV.intensity;
const key = new THREE.DirectionalLight(KEY.color, KEY.intensity);
key.position.set(...KEY.position); key.target.position.set(...KEY.target);
key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 4; key.shadow.blurSamples = 12;
Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 12 });
scene.add(key, key.target);

const gltf = new GLTFLoader();
const [cellGltf, env] = await Promise.all([gltf.loadAsync('/assets/democell.glb'), new HDRLoader().loadAsync(`/hdr/${ENV.hdr}`)]);
scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(env).texture;
const cell = cellGltf.scene;
cell.traverse((m) => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } });
cell.getObjectByName('Carrier').position.x += 1.6;   // carrier at the end stop, as in the bracket benchmark
scene.add(cell);

// ── Twin cameras (calibrated: pose and intrinsics are known in the twin) ────
export function twinCamera(name, pos, look, fov, w, h) {
  const c = new THREE.PerspectiveCamera(fov, w / h, 0.02, 20);
  c.name = name; c.position.set(...pos); c.lookAt(...look); c.updateMatrixWorld(true);
  return { camera: c, w, h };
}
const LOOK = [PLATE.x, PLATE.y + 0.04, PLATE.z];
export const CAMS = {
  inspection: twinCamera('inspection', [PLATE.x, PLATE.y + 0.42, PLATE.z + 0.42], LOOK, 35, 1024, 1024),
  side: twinCamera('side', [PLATE.x + 0.5, PLATE.y + 0.32, PLATE.z - 0.12], LOOK, 35, 1024, 1024),
  cell: twinCamera('cell', [2.0, 1.9, 0.9], LOOK, 40, 1024, 768),
};
export const cameraRecord = ({ camera, w, h }) => ({
  position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fovDeg: camera.fov, width: w, height: h,
  convention: 'three.js PerspectiveCamera: vertical fov, looks down local -Z, +Y up, metres; quaternion [x,y,z,w]',
});

// ── Parts ───────────────────────────────────────────────────────────────────
/** CAD (mm, Z up) → GLB/world-local (m, Y up). Directions use the same map without the scale. */
export const cadToGlb = ([x, y, z], scale = 0.001) => [x * scale, z * scale, -y * scale];

export async function loadPart(id) {
  const [meta, glb] = await Promise.all([(await fetch(`/parts/${id}/part.json`)).json(), gltf.loadAsync(`/parts/${id}/model.glb`)]);
  const model = glb.scene;
  model.traverse((m) => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } });
  return { id, meta, model };
}

export function posed(model, pose) {
  const g = new THREE.Group();
  g.add(model.clone(true));
  g.position.set(pose.x, PLATE.y, pose.z);
  g.rotation.set(0, pose.yaw, 0);
  g.updateMatrixWorld(true);
  return g;
}

/** Reflective-finish override: polished bright metal (the challenge condition). */
const POLISHED = new THREE.MeshPhysicalMaterial({ color: '#dfe3e8', metalness: 1, roughness: 0.06 });
function withMaterial(object, material) {
  const c = object.clone(true);
  c.traverse((m) => { if (m.isMesh) m.material = material; });
  return c;
}

// ── Utilities ───────────────────────────────────────────────────────────────
export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
/** Seed from a string: FNV-1a. */
export const hashSeed = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
async function savePng(name, canvas) { await fetch(`/save/${name}`, { method: 'POST', body: canvas.toDataURL('image/png') }); }
async function saveJson(name, data) { await fetch(`/save-json/${name}`, { method: 'POST', body: JSON.stringify(data, null, 2) }); }

function renderRgb({ camera, w, h }) {
  renderer.setSize(w, h, false);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  const c = canvasOf(w, h);
  c.getContext('2d').drawImage(renderer.domElement, 0, 0);
  return c;
}
const pixels = (mask) => mask.reduce((s, v) => s + v, 0);

/** The object on white in a 512² square crop around its mask (1.35× its larger side), as in the bracket benchmark. */
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

// ── Challenge conditions ────────────────────────────────────────────────────
/**
 * Occlusion: a cable duct (40 × 40 mm, 0.5 m long, dark plastic) in front of the part, a third of the
 * way from the part to the inspection camera, perpendicular to the view and horizontal. Its height is
 * chosen so that 55–75 % of the part stays visible to the inspection camera (target 65 %). The duct is
 * part of the twin: registration and coverage know it as an occluder.
 */
const DUCT_MAT = new THREE.MeshStandardMaterial({ color: '#3a3f46', roughness: 0.6 });
function placeDuct(part, full) {
  const { camera, w, h } = CAMS.inspection;
  const centre = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3());
  const toCam = camera.position.clone().sub(centre);
  const base = centre.clone().addScaledVector(toCam, 1 / 3);
  const right = new THREE.Vector3().crossVectors(toCam, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, toCam).normalize();
  const duct = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.04), DUCT_MAT);
  duct.name = 'Occluder_CableDuct';
  duct.castShadow = duct.receiveShadow = true;
  duct.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, right.clone().cross(up)));
  let best = null;
  for (let off = -0.08; off <= 0.08001; off += 0.004) {
    duct.position.copy(base).addScaledVector(up, off);
    duct.updateMatrixWorld(true);
    const vis = pixels(objectMask(renderer, part, camera, 256, 256, [cell, duct])) / full;
    if (vis >= 0.55 && vis <= 0.75 && (!best || Math.abs(vis - 0.65) < Math.abs(best.vis - 0.65))) best = { off, vis };
  }
  if (!best) return null;
  duct.position.copy(base).addScaledVector(up, best.off);
  duct.updateMatrixWorld(true);
  return { duct, visibleFraction: best.vis };
}

/**
 * Limited view: the inspection camera panned (about its own vertical axis) until 55–75 % of the part
 * stays inside its frame (target 65 %). The twin knows the panned pose; the part is cut by the image border.
 */
function panInspection(part, full) {
  const { camera, w, h } = CAMS.inspection;
  let best = null;
  for (let deg = 0; deg <= 30; deg += 0.5) {
    for (const sign of [-1, 1]) {
      const c = camera.clone();
      c.rotateY(sign * THREE.MathUtils.degToRad(deg)); c.updateMatrixWorld(true);
      const vis = pixels(objectMask(renderer, part, c, 256, 256, [cell])) / full;
      if (vis >= 0.55 && vis <= 0.75 && (!best || Math.abs(vis - 0.65) < Math.abs(best.vis - 0.65))) best = { c, vis, deg: sign * deg };
    }
  }
  return best && { cam: { camera: best.c, w, h }, visibleFraction: best.vis, panDeg: best.deg };
}

// ── Stage: observation sets ─────────────────────────────────────────────────
async function observe() {
  const only = params.get('part');
  const n = Number(params.get('n') ?? 10);
  for (const id of PARTS.filter((p) => !only || p === only)) {
    const { meta, model } = await loadPart(id);
    const seed = (hashSeed(id) ^ 20261006) >>> 0;
    const rand = rng(seed);
    const trials = [];
    for (let i = 0; i < n; i++) {
      const pose = { x: PLATE.x + (rand() * 2 - 1) * PLATE_RANGE.x, z: PLATE.z + (rand() * 2 - 1) * PLATE_RANGE.z, yaw: rand() * Math.PI * 2 };
      const part = posed(model, pose);
      const full = pixels(objectMask(renderer, part, CAMS.inspection.camera, 256, 256, [cell]));
      const trial = { i, pose, conditions: {} };
      for (const cond of CONDITIONS) {
        let cams = CAMS, extra = null, info = {};
        let subject = part;
        if (cond === 'occlusion') {
          const placed = placeDuct(part, full);
          if (!placed) { trial.conditions[cond] = { skipped: 'no duct height gives 55–75 % visibility' }; continue; }
          extra = placed.duct;
          info = { occluder: { name: extra.name, size: [0.5, 0.04, 0.04], position: extra.position.toArray(), quaternion: extra.quaternion.toArray() }, visibleFraction: placed.visibleFraction };
        }
        if (cond === 'limited') {
          const pan = panInspection(part, full);
          if (!pan) { trial.conditions[cond] = { skipped: 'no pan gives 55–75 % in frame' }; continue; }
          cams = { ...CAMS, inspection: pan.cam };
          info = { panDeg: pan.panDeg, visibleFraction: pan.visibleFraction };
        }
        if (cond === 'reflective') {
          subject = withMaterial(part, POLISHED);
          info = { material: { type: 'MeshPhysicalMaterial', color: '#dfe3e8', metalness: 1, roughness: 0.06 } };
        }
        scene.add(subject); if (extra) scene.add(extra);
        const occluders = extra ? [cell, extra] : [cell];
        const views = {};
        for (const v of VIEWS) {
          const cam = cams[v];
          const rgb = renderRgb(cam);
          const mask = objectMask(renderer, subject, cam.camera, cam.w, cam.h, occluders);
          const base = `parts/${id}/t${i}/${cond}-${v}`;
          await savePng(`${base}-rgb`, rgb);
          if (pixels(mask) < 400) { views[v] = { camera: cameraRecord(cam), rgb: `${base}-rgb.png`, crop: null, maskPixels: pixels(mask), note: 'part not visible enough for a crop' }; continue; }
          await savePng(`${base}-crop`, maskedCrop(rgb, mask, cam.w, cam.h));
          views[v] = { camera: cameraRecord(cam), rgb: `${base}-rgb.png`, crop: `${base}-crop.png`, maskPixels: pixels(mask) };
        }
        scene.remove(subject); if (extra) scene.remove(extra);
        trial.conditions[cond] = { ...info, views };
      }
      trials.push(trial);
      log(`${id} trial ${i}: ${Object.entries(trial.conditions).map(([c, v]) => `${c}${v.skipped ? ' (skipped)' : ''}`).join(', ')}`);
    }
    await saveJson(`parts/${id}/observations`, {
      part: id, seed, poses: n, plate: PLATE.toArray(), plateRange: PLATE_RANGE,
      lighting: { environment: ENV, key: KEY, toneMapping: 'NeutralToneMapping', shadows: 'VSM 2048' },
      cameras: Object.fromEntries(Object.entries(CAMS).map(([k, c]) => [k, cameraRecord(c)])),
      coordinates: 'world metres, +Y up; part GLB metric +Y up, resting base at y = 0; CAD mm Z up → GLB [x, z, -y] / 1000',
      cropRule: 'object pixels on white, square 1.35 × the mask bounding box, resampled to 512 × 512',
      conditions: CONDITIONS, views: VIEWS, trials,
      generatorInputs: 'crop images only; no CAD, part.json, feature inventory or declared size reaches the generator',
    });
    log(`${id}: observation set saved`);
  }
  log('observe stage done');
}

// ── Stage: camera preview ───────────────────────────────────────────────────
async function preview() {
  for (const id of PARTS) {
    const { model } = await loadPart(id);
    const part = posed(model, { x: PLATE.x, z: PLATE.z, yaw: 0.6 });
    scene.add(part);
    for (const v of VIEWS) await savePng(`parts/preview/${id}-${v}`, renderRgb(CAMS[v]));
    scene.remove(part);
  }
  log('preview done');
}

// ── Evaluation: geometry helpers ────────────────────────────────────────────
const MM = 1000;
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };

export function cameraFrom(rec) {
  const c = new THREE.PerspectiveCamera(rec.fovDeg, rec.width / rec.height, 0.02, 20);
  c.position.fromArray(rec.position); c.quaternion.fromArray(rec.quaternion); c.updateMatrixWorld(true);
  return c;
}
function ductFrom(rec) {
  const d = new THREE.Mesh(new THREE.BoxGeometry(...rec.size), DUCT_MAT);
  d.name = rec.name; d.position.fromArray(rec.position); d.quaternion.fromArray(rec.quaternion); d.updateMatrixWorld(true);
  return d;
}

/** World-space vertices of every mesh under `object`. */
function worldPoints(object) {
  object.updateMatrixWorld(true);
  const pts = [], v = new THREE.Vector3();
  object.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
  });
  return pts;
}

/** Height and the long/short sides of the minimum-area footprint rectangle (ground plane), in metres. */
export function dims(object) {
  const pts = worldPoints(object);
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const xz = pts.map((p) => [p.x, p.z]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (arr) => { const h = []; for (const p of arr) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  const hull = [...half(xz), ...half([...xz].reverse())];
  let best = { area: Infinity, long: 0, short: 0 };
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
    const len = Math.hypot(bx - ax, bz - az); if (!len) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [px, pz] of hull) { const u = px * ux + pz * uz, w = -px * uz + pz * ux; a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, w); b1 = Math.max(b1, w); }
    const area = (a1 - a0) * (b1 - b0);
    if (area < best.area) best = { area, long: Math.max(a1 - a0, b1 - b0), short: Math.min(a1 - a0, b1 - b0) };
  }
  return { height: maxY - minY, long: best.long, short: best.short };
}

// Exact world-space bounding box (from the vertices). three.js's default box transforms each mesh's local box
// and so inflates with the mesh's rotation; a reconstruction registered in a different local frame (e.g. 45° off
// on the 8-fold symmetric flange) would show a size error it does not have. The default box's values are kept
// alongside as a sensitivity (`boxOfBoxes`, protocol §6).
function boxOf(object) { object.updateMatrixWorld(true); return new THREE.Box3().setFromObject(object, true); }
function boxOfBoxes(object) { object.updateMatrixWorld(true); return new THREE.Box3().setFromObject(object); }
function placementMetrics(placed, gt, gtDims) {
  const a = boxOf(placed), b = boxOf(gt);
  const fa = boxOfBoxes(placed), fb = boxOfBoxes(gt);
  const d = dims(placed);
  const dev = computeDeviation(placed, gt, 6000);
  return {
    boxOfBoxes: {
      centreErrMm: fa.getCenter(new THREE.Vector3()).distanceTo(fb.getCenter(new THREE.Vector3())) * MM,
      sizeErrPct: (fa.getSize(new THREE.Vector3()).length() / fb.getSize(new THREE.Vector3()).length() - 1) * 100,
    },
    centreErrMm: a.getCenter(new THREE.Vector3()).distanceTo(b.getCenter(new THREE.Vector3())) * MM,
    sizeErrPct: (a.getSize(new THREE.Vector3()).length() / b.getSize(new THREE.Vector3()).length() - 1) * 100,
    dims: { heightErrMm: (d.height - gtDims.height) * MM, longErrMm: (d.long - gtDims.long) * MM, shortErrMm: (d.short - gtDims.short) * MM },
    chamferMm: dev.chamfer * MM, hausdorffMm: dev.hausdorff * MM,
  };
}

// ── Evaluation: generic feature test (protocol §7) ─────────────────────────────────────────────────
const NOT_TESTED_TYPES = new Set(['bend']);
function featureGeometry(f) {
  const depth = f.depth ?? f.height ?? null;
  const rMax = (f.diameter ?? f.outerDiameter ?? Math.max(f.length ?? 0, f.width ?? 0)) / 2;
  const rMin = f.diameter ? f.diameter / 2 : f.outerDiameter ? (f.outerDiameter - f.innerDiameter) / 2 : Math.min(f.width ?? rMax * 2, f.length ?? rMax * 2) / 2;
  return { depth, rMax, rMin };
}

/**
 * Probe set of one feature on the posed reference: a grid of probe lines parallel to the feature axis, the
 * reference depth profile, the feature region (flood-filled from the centre) and its surround. Units: mm.
 */
function featureProbes(f, gt, gtBvh) {
  const { depth, rMax, rMin } = featureGeometry(f);
  if (NOT_TESTED_TYPES.has(f.type) || !depth || depth < 2 || !rMax) return null;
  const toWorld = (p) => new THREE.Vector3(...cadToGlb(p)).applyMatrix4(gt.matrixWorld);
  const centre = toWorld(f.center);
  const axis = new THREE.Vector3(...cadToGlb(f.axis, 1)).transformDirection(gt.matrixWorld).normalize();
  const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const L = Math.min(depth + 10, 70) / MM, back = 10 / MM;
  const firstHit = (bvh, origin, dir) => { const h = bvh.raycastFirst(new THREE.Ray(origin, dir), THREE.DoubleSide, 0, L + back); return h ? (h.distance - back) * MM : (L) * MM; };
  // Which way is "into the part": the side where probes just outside the feature first hit the face 10 mm away.
  const ring = Array.from({ length: 8 }, (_, k) => u.clone().multiplyScalar(Math.cos(k * Math.PI / 4)).addScaledVector(v, Math.sin(k * Math.PI / 4)).multiplyScalar(1.3 * rMax / MM));
  const score = (s) => median(ring.map((o) => Math.abs(firstHit(gtBvh, centre.clone().add(o).addScaledVector(axis, -s * back), axis.clone().multiplyScalar(s)))));
  const s = score(1) <= score(-1) ? 1 : -1;
  const inward = axis.clone().multiplyScalar(s);
  const spacing = Math.min(2, Math.max(0.5, rMin / 2));
  const halfN = Math.ceil((2.0 * rMax) / spacing);
  const probes = [];
  for (let a = -halfN; a <= halfN; a++) for (let b = -halfN; b <= halfN; b++) {
    const lat = u.clone().multiplyScalar(a * spacing / MM).addScaledVector(v, b * spacing / MM);
    const entry = centre.clone().add(lat);
    const origin = entry.clone().addScaledVector(inward, -back);
    probes.push({ a, b, r: Math.hypot(a, b) * spacing, entry, origin, ref: firstHit(gtBvh, origin, inward) });
  }
  const full = L * MM - 0.01;
  const outer = probes.filter((p) => p.r > 1.1 * rMax && p.ref < full);
  const base = median((outer.length ? outer : probes.filter((p) => p.ref < full)).map((p) => p.ref));
  for (const p of probes) { p.diff = p.ref - base; p.inRegion = Math.abs(p.diff) > 0.5 * depth; p.surround = p.ref < full && Math.abs(p.diff) < 0.25 * depth; }
  // Feature region: the region probes connected (4-neighbourhood) to the one nearest the centre.
  const key = (a, b) => `${a},${b}`, byKey = new Map(probes.map((p) => [key(p.a, p.b), p]));
  const seed = probes.filter((p) => p.inRegion).sort((x, y) => x.r - y.r)[0];
  const region = new Set();
  if (seed) {
    const stack = [seed];
    while (stack.length) {
      const p = stack.pop(); if (region.has(p)) continue; region.add(p);
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = byKey.get(key(p.a + da, p.b + db)); if (q?.inRegion && !region.has(q)) stack.push(q); }
    }
  }
  return { f, depth, rMax, inward, probes, region: [...region], surround: probes.filter((p) => p.surround), allRegion: probes.filter((p) => p.inRegion).length, firstHit, full, outward: inward.clone().negate() };
}

function featureOutcome(set, bvh, visCams, visBvh) {
  if (!set) return null;
  const { depth, rMax, region, surround, probes, firstHit, inward, full } = set;
  // Body: the outer ring of the surround (r >= 1.7 x the feature radius), so a widened or misplaced feature does not read as a missing body.
  const outerRing = surround.filter((p) => p.r >= 1.7 * rMax);
  const ring = outerRing.length >= 8 ? outerRing : surround;   // stepped surroundings (e.g. a groove on a hub): the whole surround
  if (!region.length) return { id: set.f.id, type: set.f.type, outcome: 'not-tested', reason: 'no feature region on the reference' };
  const rec = new Map(probes.map((p) => [p, firstHit(bvh, p.origin, inward)]));
  const hits = surround.filter((p) => rec.get(p) < full);
  const recBase = median(hits.map((p) => rec.get(p)));
  const body = ring.length ? ring.filter((p) => rec.get(p) < full && Math.abs(rec.get(p) - recBase) < 0.5 * depth).length / ring.length : 0;
  const like = (p) => { const d = rec.get(p) - recBase; return Math.sign(d) === Math.sign(p.diff) && Math.abs(d) > 0.5 * depth; };
  const recall = region.filter(like).length / region.length;
  const areaRatio = probes.filter((p) => { const d = rec.get(p) - recBase; return Math.abs(d) > 0.5 * depth; }).length / Math.max(1, set.allRegion);
  const seenFraction = visCams ? region.filter((p) => observationAt(p.entry.clone().addScaledVector(set.outward, 1e-4), set.outward, visCams, visBvh, Math.cos(THREE.MathUtils.degToRad(80)), 1e-4) > 0).length / region.length : null;
  const outcome = !Number.isFinite(recBase) || body < 0.75 ? 'no-body' : recall >= 0.6 ? 'recovered' : recall >= 0.25 ? 'partial' : 'missing';
  return { id: set.f.id, type: set.f.type, outcome, recall, body, areaRatio, seenFraction, seen: seenFraction === null ? null : seenFraction >= 0.5, regionProbes: region.length };
}

function featureReport(sets, model, visCams, visBvh) {
  const bvh = worldBVH(model).bvh;
  return sets.map((s) => s ? featureOutcome(s, bvh, visCams, visBvh) : null).filter(Boolean);
}

// ── Evaluation: registration and the policy (protocol §5) ──────────────────────────────────────────
// Generation budget per trial for C and D (?budget=…); the reported results use 2.
const TAU = 0.90, DIM_TOL = 0.10, BUDGET = Number(params.get('budget') ?? 2);
const reconCache = new Map();
async function loadRecon(sha) {
  if (!reconCache.has(sha)) {
    const r = await fetch(`/cache/parts-recon/${sha}.glb`, { method: 'HEAD' });
    reconCache.set(sha, r.ok ? (await gltf.loadAsync(`/cache/parts-recon/${sha}.glb`)).scene : null);
  }
  return reconCache.get(sha);
}
async function jobRecord(sha) { const r = await fetch(`/cache/parts-recon/${sha}.json`); return r.ok ? r.json() : null; }

async function evaluate() {
  const only = params.get('part'), onlyCond = params.get('cond');
  // ?dryrun=reference exercises the pipeline with the reference model in place of every reconstruction
  // (a code check that reveals no test outcome); its output goes to results-dryrun.json, never to results.
  const dryrun = params.get('dryrun') === 'reference';
  const index = await (await fetch('/cache/parts-recon/index.json')).json();
  // ?reuse=<dir>: coverage and features are taken from an earlier run's rows (same trial, condition
  // and view) instead of being recomputed; they depend on the registered geometry, not on the box.
  const reuseDir = params.get('reuse');
  for (const id of PARTS.filter((p) => !only || p === only)) {
    const prior = reuseDir ? (await (await fetch(`/out/${reuseDir}/parts/${id}/results.json`)).json()).rows : null;
    const { meta, model } = await loadPart(id);
    const obs = await (await fetch(`/out/parts/${id}/observations.json`)).json();
    const declared = meta.declaredSize;                                    // AAS nominal dimensions (synthetic, CAD-derived)
    const declaredLongest = Math.max(declared.length, declared.width, declared.height) / MM;
    const declaredHeight = declared.height / MM;
    const rows = [];
    for (const t of obs.trials) {
      const gt = posed(model, t.pose);
      const gtDims = dims(gt);
      const gtBvh = worldBVH(gt).bvh;
      const sets = meta.features.map((f) => featureProbes(f, gt, gtBvh));
      for (const [cond, c] of Object.entries(t.conditions)) {
        if (onlyCond && cond !== onlyCond) continue;
        if (c.skipped) { rows.push({ trial: t.i, cond, skipped: c.skipped }); continue; }
        const duct = c.occluder ? ductFrom(c.occluder) : null;
        const occluders = duct ? [cell, duct] : [cell];
        const subject = gt;   // masks are geometric; material does not change them
        const views = Object.entries(c.views).filter(([, v]) => v.crop).map(([name, v]) => {
          const camera = cameraFrom(v.camera), w = 256, h = Math.round(256 * v.camera.height / v.camera.width);
          return { name, camera, width: w, height: h, mask: objectMask(renderer, subject, camera, w, h, occluders), crop: v.crop, maskPixels: v.maskPixels };
        });
        const regViews = views.map(({ camera, width, height, mask }) => ({ camera, width, height, mask }));
        const visBvh = worldBVH([gt, ...occluders]).bvh;
        const register = (mesh, prior) => registerToSilhouettes(renderer, mesh, regViews, { supportY: PLATE.y, declaredSize: prior ? declaredLongest : undefined, occluders, seed: 3 });
        const row = { trial: t.i, cond, conditions: {} };

        // Candidates by view: one generation each (cached by crop hash; stored meshes are reused).
        const candidates = new Map();
        const candidate = async (view, prior) => {
          const k = `${view.name}|${prior}`;
          if (candidates.has(k)) return candidates.get(k);
          const sha = index[view.crop];
          const mesh = dryrun ? model.clone(true) : sha ? await loadRecon(sha) : null;
          const job = sha ? await jobRecord(sha) : null;
          let cand = { view: view.name, prior, sha, generated: !!mesh, generationSeconds: job?.seconds ?? null, generationStatus: job?.status ?? 'missing' };
          if (mesh) {
            const r = await register(mesh, prior);
            const placed = poseModel(mesh, r);
            const d = dims(placed);
            cand = { ...cand, r, placed, mesh, agreement: Math.min(...r.iou), heightRatio: d.height / declaredHeight, longestRatio: longestDimension(placed) / declaredLongest };
            cand.dimsOk = Math.abs(cand.heightRatio - 1) <= DIM_TOL && Math.abs(cand.longestRatio - 1) <= DIM_TOL;
            cand.verified = cand.agreement >= TAU && cand.dimsOk;
          }
          candidates.set(k, cand);
          return cand;
        };
        const measured = new Map();
        const priorRow = prior?.find((x) => x.trial === t.i && x.cond === cond);
        const reused = (cand) => (cand.prior ? ['B', 'C', 'D'] : ['A']).map((k) => priorRow?.conditions?.[k]).find((x) => x?.view === cand.view && x.coverage !== undefined && x.features);
        const measure = (cand, genCams) => {
          if (!cand?.placed || !genCams.length) return { failed: true, reason: cand ? `generation ${cand.generationStatus}` : 'no candidate' };
          if (measured.has(cand)) return measured.get(cand);
          const m = placementMetrics(cand.placed, gt, gtDims);
          const old = reused(cand);
          const evidence = old ? { coverage: old.coverage, features: old.features, evidenceReused: reuseDir }
            : { coverage: computeCoverage(cand.placed, genCams, { occluders, samples: 6000 }).fraction, features: featureReport(sets, cand.placed, genCams, visBvh) };
          const out = { ...m, iou: cand.r.iou, ms: Math.round(cand.r.ms), ...evidence, failed: m.centreErrMm > 10 || Math.abs(m.sizeErrPct) > 10 };
          measured.set(cand, out);
          return out;
        };
        const inspection = views.find((v) => v.name === 'inspection') ?? [...views].sort((a, b) => b.maskPixels - a.maskPixels)[0];
        const camOf = (name) => views.find((v) => v.name === name).camera;

        // Naive drop.
        const naiveSha = index[inspection.crop], naiveMesh = dryrun ? model.clone(true) : naiveSha ? await loadRecon(naiveSha) : null;
        if (naiveMesh) {
          const c0 = maskCentroidOnPlane(regViews[views.indexOf(inspection)], PLATE.y);
          const ext = boxOf(naiveMesh).getSize(new THREE.Vector3());
          const placed = poseModel(naiveMesh, { position: [c0.x, PLATE.y, c0.z], rotation: [0, 0, 0], scale: 0.15 / Math.max(ext.x, ext.y, ext.z) });
          const m = placementMetrics(placed, gt, gtDims);
          row.conditions.naive = { ...m, failed: m.centreErrMm > 10 || Math.abs(m.sizeErrPct) > 10 };
        }
        // A: images; B: images + AAS.
        const a = await candidate(inspection, false), b = await candidate(inspection, true);
        row.conditions.A = { view: a.view, generations: 1, generationSeconds: a.generationSeconds, ...measure(a, [camOf(a.view)]) };
        row.conditions.B = { view: b.view, generations: 1, generationSeconds: b.generationSeconds, agreement: b.agreement, dimsOk: b.dimsOk, verified: b.verified, ...measure(b, [camOf(b.view)]) };
        // C: evidence-driven regeneration (lib/grounding-src/policy.ts), the same function a live twin runs.
        const policyViews = views.map((v) => ({ name: v.name, maskPixels: v.maskPixels }));
        const policy = await groundWithVerification(policyViews, async (pv) => {
          const cand = await candidate(views.find((v) => v.name === pv.name), true);
          return cand.placed ? cand : null;
        }, { tau: TAU, dimTolerance: DIM_TOL, budget: BUDGET, first: inspection.name });
        const tried = policy.decisions.map((d) => candidates.get(`${d.view}|true`));
        const chosen = policy.chosen?.candidate ?? tried[0];
        row.conditions.C = { view: chosen?.view, generations: policy.generations, generationSeconds: tried.reduce((s, x) => s + (x?.generationSeconds ?? 0), 0), unverified: policy.unverified, decisions: policy.decisions, ...measure(chosen, chosen?.view ? [camOf(chosen.view)] : []) };
        const order = [inspection, ...views.filter((v) => v !== inspection).sort((x, y) => y.maskPixels - x.maskPixels)];
        // D: all views, best agreement (control).
        const all = []; for (const view of order.slice(0, BUDGET)) all.push(await candidate(view, true));
        const best = all.filter((x) => x.placed).sort((x, y) => y.agreement - x.agreement)[0] ?? all[0];
        row.conditions.D = { view: best?.view, generations: all.length, generationSeconds: all.reduce((s, x) => s + (x.generationSeconds ?? 0), 0), ...measure(best, [camOf(best.view)]) };
        rows.push(row);
        log(`${id} t${t.i} ${cond}: A ${f1(row.conditions.A.centreErrMm)} · B ${f1(row.conditions.B.centreErrMm)} · C ${f1(row.conditions.C.centreErrMm)} (${row.conditions.C.generations} gen${row.conditions.C.unverified ? ', unverified' : ''}) · D ${f1(row.conditions.D.centreErrMm)} mm`);
      }
      // With ?cond=, the rows go to results-<cond>.json, merged afterwards (merge-parts-results.mjs).
      await saveJson(`parts/${id}/results${dryrun ? '-dryrun' : ''}${onlyCond ? `-${onlyCond}` : ''}`, { part: id, dryrun, protocol: 'protocol/PROTOCOL.md', tau: TAU, dimTolerance: DIM_TOL, budget: BUDGET, declared, rows });
    }
    log(`${id}: results saved`);
  }
  log('evaluate stage done');
}
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–');

// ── Stage: metric validation on known perturbations (protocol §8) ──────────────────────────────────
async function validate() {
  const out = [];
  for (const id of PARTS) {
    const { meta, model } = await loadPart(id);
    const obs = await (await fetch(`/out/parts/${id}/observations.json`)).json();
    const pert = await (await fetch(`/parts/${id}/perturbed/perturbations.json`)).json();
    const pose = obs.trials[0].pose;
    const gt = posed(model, pose);
    const gtDims = dims(gt), gtBvh = worldBVH(gt).bvh;
    const sets = meta.features.map((f) => featureProbes(f, gt, gtBvh));
    const cam = [cameraFrom(obs.trials[0].conditions.standard.views.inspection.camera)];
    const visBvh = worldBVH([gt, cell]).bvh;
    const h = gtDims.height;
    const variant = (name, object, expect) => {
      const m = placementMetrics(object, gt, gtDims);
      const feats = featureReport(sets, object, cam, visBvh);
      out.push({ part: id, variant: name, expect, ...m, features: feats });
    };
    const moved = (dx) => { const g = gt.clone(true); g.position.x += dx; g.updateMatrixWorld(true); return g; };
    const scaled = (s) => { const g = new THREE.Group(); const c = gt.clone(true); g.add(c); g.position.set(gt.position.x, PLATE.y, gt.position.z); c.position.set(0, 0, 0); g.scale.setScalar(s); g.updateMatrixWorld(true); return g; };
    const noisy = (sigma, seed) => {
      const r = rng(seed); const g = gt.clone(true);
      const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
      g.traverse((m) => { if (!m.isMesh) return; m.geometry = m.geometry.clone(); const p = m.geometry.attributes.position; for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + gauss() * sigma, p.getY(i) + gauss() * sigma, p.getZ(i) + gauss() * sigma); p.needsUpdate = true; m.geometry.computeBoundingBox(); });
      g.updateMatrixWorld(true); return g;
    };
    variant('identity', gt.clone(true), { centreErrMm: 0, sizeErrPct: 0, featuresRecovered: '>= 95 %' });
    // Same world geometry under a rotated local frame: geometry baked by -θ, node rotated by +θ.
    // A box-of-boxes AABB inflates here; the vertex-exact box must not.
    const reframed = (deg) => {
      const g = gt.clone(true); g.updateMatrixWorld(true);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
      g.traverse((m) => { if (!m.isMesh) return; m.geometry = m.geometry.clone(); m.geometry.applyQuaternion(q.clone().invert()); m.quaternion.multiply(q); });
      g.updateMatrixWorld(true); return g;
    };
    for (const deg of [30, 45]) variant(`reframe-${deg}deg`, reframed(deg), { centreErrMm: 0, sizeErrPct: 0 });
    for (const mm of [2, 5, 10]) variant(`translate-${mm}mm`, moved(mm / MM), { centreErrMm: mm, sizeErrPct: 0 });
    for (const s of [0.95, 1.05]) variant(`scale-${s}`, scaled(s), { centreErrMm: Math.abs(s - 1) * h / 2 * MM, sizeErrPct: (s - 1) * 100, heightErrMm: (s - 1) * h * MM });
    for (const sigma of [0.5, 1]) variant(`noise-${sigma}mm`, noisy(sigma / MM, 7 + sigma * 10), { note: 'Chamfer of the order of sigma; features mostly recovered' });
    for (const [kind, spec] of Object.entries(pert.variants)) {
      const g = posed((await gltf.loadAsync(`/parts/${id}/perturbed/${kind}.glb`)).scene, pose);
      variant(`${kind}:${pert.feature}`, g, { feature: pert.feature, ...spec });
    }
    log(`${id}: validation variants done`);
  }
  // Pass/fail against the protocol's criteria.
  const checks = [];
  const featOf = (row, fid) => row.features.find((x) => x.id === fid);
  for (const row of out) {
    const e = row.expect;
    if (row.variant === 'identity') {
      const tested = row.features.filter((x) => x.outcome !== 'not-tested');
      const rec = tested.filter((x) => x.outcome === 'recovered').length / Math.max(1, tested.length);
      checks.push({ part: row.part, check: 'identity: features recovered ≥ 95 %', value: rec, pass: rec >= 0.95 });
      checks.push({ part: row.part, check: 'identity: centre error ≈ 0', value: row.centreErrMm, pass: row.centreErrMm < 0.5 });
    } else if (row.variant.startsWith('translate') || row.variant.startsWith('scale') || row.variant.startsWith('reframe')) {
      checks.push({ part: row.part, check: `${row.variant}: centre error`, value: row.centreErrMm, expected: e.centreErrMm, pass: Math.abs(row.centreErrMm - e.centreErrMm) <= 0.5 });
      checks.push({ part: row.part, check: `${row.variant}: size error`, value: row.sizeErrPct, expected: e.sizeErrPct, pass: Math.abs(row.sizeErrPct - e.sizeErrPct) <= 0.5 });
      if (e.heightErrMm !== undefined) checks.push({ part: row.part, check: `${row.variant}: height error`, value: row.dims.heightErrMm, expected: e.heightErrMm, pass: Math.abs(row.dims.heightErrMm - e.heightErrMm) <= 0.5 });
    } else if (row.variant.includes(':')) {
      const f = featOf(row, e.feature);
      const ok = row.variant.startsWith('plugged') ? f?.outcome === 'missing'
        : row.variant.startsWith('enlarged') ? f?.outcome === 'recovered' && f.areaRatio > e.expectedAreaRatioAbove
          : ['partial', 'missing'].includes(f?.outcome);
      checks.push({ part: row.part, check: `${row.variant}`, value: f ? { outcome: f.outcome, recall: f.recall, areaRatio: f.areaRatio } : null, expected: e.expected, pass: !!ok });
    }
  }
  const passed = checks.every((c) => c.pass);
  await saveJson('parts/metric-validation', { passed, checks, rows: out });
  log(`metric validation: ${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
  checks.filter((c) => !c.pass).forEach((c) => log(`  FAIL ${c.part} ${c.check}: ${JSON.stringify(c.value)} (expected ${JSON.stringify(c.expected ?? '')})`));
}


// ── Extra analyses E1 and E2 (protocol §1, §5) ──
// Both run on stored reconstructions and call no generator. Outputs:
// out/parts-extra/{baselines,heldout}/<part>.json.
//   /partbench.html?stage=baselines[&part=<id>]   E1: single generation (largest mask first; side only)
//   /partbench.html?stage=heldout[&part=<id>]     E2: held-out third camera on the arm-B candidate
async function extraSetup(id) {
  const { meta, model } = await loadPart(id);
  const obs = await (await fetch(`/out/parts/${id}/observations.json`)).json();
  const stored = (await (await fetch(`/out/parts/${id}/results.json`)).json()).rows;
  const index = await (await fetch('/cache/parts-recon/index.json')).json();
  const declared = meta.declaredSize;
  return { meta, model, obs, stored, index, declaredLongest: Math.max(declared.length, declared.width, declared.height) / MM, declaredHeight: declared.height / MM };
}
function extraViews(c, gt) {
  const duct = c.occluder ? ductFrom(c.occluder) : null;
  const occluders = duct ? [cell, duct] : [cell];
  const views = Object.entries(c.views).filter(([, v]) => v.crop).map(([name, v]) => {
    const camera = cameraFrom(v.camera), w = 256, h = Math.round(256 * v.camera.height / v.camera.width);
    return { name, camera, width: w, height: h, mask: objectMask(renderer, gt, camera, w, h, occluders), crop: v.crop, maskPixels: v.maskPixels };
  });
  return { views, occluders };
}
const regOf = (vs) => vs.map(({ camera, width, height, mask }) => ({ camera, width, height, mask }));
const pick = (m) => ({ centreErrMm: m.centreErrMm, sizeErrPct: m.sizeErrPct, chamferMm: m.chamferMm, failed: m.centreErrMm > 10 || Math.abs(m.sizeErrPct) > 10 });

async function baselines() {
  const only = params.get('part');
  for (const id of PARTS.filter((p) => !only || p === only)) {
    const S = await extraSetup(id);
    const rows = [];
    for (const t of S.obs.trials) {
      const gt = posed(S.model, t.pose), gtDims = dims(gt);
      for (const [cond, c] of Object.entries(t.conditions)) {
        if (c.skipped) { rows.push({ trial: t.i, cond, skipped: c.skipped }); continue; }
        const { views, occluders } = extraViews(c, gt);
        const regViews = regOf(views);
        const storedRow = S.stored.find((x) => x.trial === t.i && x.cond === cond);
        const storedFor = (name) => ['B', 'C', 'D'].map((k) => storedRow?.conditions?.[k]).find((x) => x?.view === name && Number.isFinite(x.centreErrMm));
        const largest = [...views].sort((a, b) => (b.maskPixels - a.maskPixels) || ((b.name === 'inspection') - (a.name === 'inspection')))[0];
        const side = views.find((v) => v.name === 'side');
        const row = { trial: t.i, cond, rules: {} };
        for (const [rule, view] of [['largestMask', largest], ['sideOnly', side]]) {
          if (!view) { row.rules[rule] = { view: null, reason: 'no crop for this view' }; continue; }
          const sha = S.index[view.crop];
          const mesh = sha ? await loadRecon(sha) : null;
          if (!mesh) { row.rules[rule] = { view: view.name, sha, reason: 'no stored reconstruction' }; continue; }
          const r = await registerToSilhouettes(renderer, mesh, regViews, { supportY: PLATE.y, declaredSize: S.declaredLongest, occluders, seed: 3 });
          const placed = poseModel(mesh, r);
          const m = placementMetrics(placed, gt, gtDims);
          const st = storedFor(view.name);
          row.rules[rule] = { view: view.name, sha, generations: 1, iou: r.iou, ms: Math.round(r.ms), ...pick(m), stored: st ? pick(st) : null };
        }
        rows.push(row);
        const L = row.rules.largestMask;
        log(`${id} t${t.i} ${cond}: largest=${L.view} ${f1(L.centreErrMm)} mm${L.stored ? ` (stored ${f1(L.stored.centreErrMm)})` : ' (new)'} · side ${f1(row.rules.sideOnly.centreErrMm)} mm`);
      }
    }
    await saveJson(`parts-extra/baselines/${id}`, { part: id, protocol: 'protocol/PROTOCOL.md', rows });
    log(`${id}: baselines saved`);
  }
  log('baselines stage done');
}

async function heldout() {
  const only = params.get('part');
  for (const id of PARTS.filter((p) => !only || p === only)) {
    const S = await extraSetup(id);
    const rows = [];
    for (const t of S.obs.trials) {
      const gt = posed(S.model, t.pose), gtDims = dims(gt);
      for (const [cond, c] of Object.entries(t.conditions)) {
        if (c.skipped) { rows.push({ trial: t.i, cond, skipped: c.skipped }); continue; }
        const { views, occluders } = extraViews(c, gt);
        const insp = views.find((v) => v.name === 'inspection') ?? [...views].sort((a, b) => b.maskPixels - a.maskPixels)[0];
        const sha = S.index[insp.crop];
        const mesh = sha ? await loadRecon(sha) : null;
        const row = { trial: t.i, cond, candidateView: insp.name, sha, folds: {} };
        for (const held of views) {
          const fit = views.filter((v) => v !== held);
          if (fit.length < 2) { row.folds[held.name] = { reason: `only ${fit.length} other view(s)` }; continue; }
          if (!mesh) { row.folds[held.name] = { reason: 'no stored reconstruction' }; continue; }
          const r = await registerToSilhouettes(renderer, mesh, regOf(fit), { supportY: PLATE.y, declaredSize: S.declaredLongest, occluders, seed: 3 });
          const placed = poseModel(mesh, r);
          const heldIoU = iou(objectMask(renderer, placed, held.camera, held.width, held.height, occluders), held.mask);
          const d = dims(placed);
          const dimsOk = Math.abs(d.height / S.declaredHeight - 1) <= DIM_TOL && Math.abs(longestDimension(placed) / S.declaredLongest - 1) <= DIM_TOL;
          const fittedOk = Math.min(...r.iou) >= TAU && dimsOk;
          const m = placementMetrics(placed, gt, gtDims);
          row.folds[held.name] = { fitViews: fit.map((v) => v.name), fitIoU: r.iou, dimsOk, fittedOk, heldIoU, heldFlag: heldIoU < TAU, ms: Math.round(r.ms), ...pick(m) };
        }
        rows.push(row);
        log(`${id} t${t.i} ${cond}: ` + Object.entries(row.folds).map(([k, f]) => `${k} ${f.reason ?? `${f1(f.centreErrMm)} mm, held IoU ${f.heldIoU.toFixed(2)}`}`).join(' · '));
      }
    }
    await saveJson(`parts-extra/heldout/${id}`, { part: id, protocol: 'protocol/PROTOCOL.md', tau: TAU, rows });
    log(`${id}: heldout saved`);
  }
  log('heldout stage done');
}
const STAGES = { observe, preview, validate, evaluate, baselines, heldout };
try {
  if (!STAGES[stage]) throw new Error(`unknown stage "${stage}" (${Object.keys(STAGES).join(', ')})`);
  await STAGES[stage]();
  window.__done = true;
} catch (e) {
  log(`Error: ${e.message}`);
  window.__failed = true;
}
if (window.parent !== window) window.parent.postMessage({ bench: window.__done ? 'done' : 'failed' }, '*');

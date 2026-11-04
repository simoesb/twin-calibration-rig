// Multi-part gallery for the paper: path-traced close-ups of one trial per test part, matching the
// bracket figures (coverage hatching, deviation map, ground truth).
//
//   /gallery.html?part=<id>&trial=<i>&pass=coverage|deviation|groundtruth[&chunk=k][&w=1200][&spp=96]
//
// The reconstruction is condition B's (inspection crop, all twin cameras, declared size), re-registered
// here (deterministic, identical to the evaluation). Chunks are averaged by average-chunks.mjs, as for
// the bracket. Saves out/parts/gallery/<part>-t<i>-<pass>[-c<k>].png and the crop the generator saw.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WebGLPathTracer, PhysicalCamera } from 'three-gpu-pathtracer';
import { registerToSilhouettes, poseModel, objectMask, computeCoverage, computeDeviation, applyDeviationShading, meshesOf } from '/lib/grounding.js';

const params = new URLSearchParams(location.search);
const log = (s) => { document.getElementById('log').textContent += `${s}\n`; console.log(s); };
const PLATE = new THREE.Vector3(1.28, 0.83, 0.01);
const MM = 1000;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.domElement.addEventListener('webglcontextlost', () => { window.__lost = true; });
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e8ebee');
scene.environmentIntensity = 0.9;
const gltf = new GLTFLoader();
const [cellGltf, env] = await Promise.all([gltf.loadAsync('/assets/democell.glb'), new HDRLoader().loadAsync('/hdr/empty_warehouse_01_1k.hdr')]);
env.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = env;
const cell = cellGltf.scene;
cell.getObjectByName('Carrier').position.x += 1.6;
scene.add(cell);

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
async function savePng(name, canvas) { await fetch(`/save/${name}`, { method: 'POST', body: canvas.toDataURL('image/png') }); }
const cameraFrom = (rec) => { const c = new THREE.PerspectiveCamera(rec.fovDeg, rec.width / rec.height, 0.02, 20); c.position.fromArray(rec.position); c.quaternion.fromArray(rec.quaternion); c.updateMatrixWorld(true); return c; };
const tick = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });

async function main() {
  const id = params.get('part'), trialNo = Number(params.get('trial') ?? 0), pass = params.get('pass') ?? 'coverage';
  const chunk = params.get('chunk');
  const W = Number(params.get('w') ?? 1200), H = Math.round((W * 3) / 4), spp = Number(params.get('spp') ?? 96);
  const meta = await (await fetch(`/parts/${id}/part.json`)).json();
  const obs = await (await fetch(`/out/parts/${id}/observations.json`)).json();
  const index = await (await fetch('/cache/parts-recon/index.json')).json();
  const t = obs.trials.find((x) => x.i === trialNo);
  const c = t.conditions.standard;
  const model = (await gltf.loadAsync(`/parts/${id}/model.glb`)).scene;
  const gt = new THREE.Group(); gt.add(model); gt.position.set(t.pose.x, PLATE.y, t.pose.z); gt.rotation.set(0, t.pose.yaw, 0); gt.updateMatrixWorld(true);
  const sha = index[c.views.inspection.crop];
  const recon = (await gltf.loadAsync(`/cache/parts-recon/${sha}.glb`)).scene;
  const views = Object.values(c.views).filter((v) => v.crop).map((v) => { const camera = cameraFrom(v.camera), w = 256, h = Math.round(256 * v.camera.height / v.camera.width); return { camera, width: w, height: h, mask: objectMask(renderer, gt, camera, w, h, [cell]) }; });
  const d = meta.declaredSize;
  const r = await registerToSilhouettes(renderer, recon, views, { supportY: PLATE.y, declaredSize: Math.max(d.length, d.width, d.height) / MM, occluders: [cell], seed: 3 });
  const placed = poseModel(recon, r);
  const inspection = cameraFrom(c.views.inspection.camera);
  const name = `parts/gallery/${id.replace('pilot-', '')}-t${trialNo}`;
  if (pass === 'crop') { const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `/out/${c.views.inspection.crop}`; }); const cv = canvasOf(512, 512); cv.getContext('2d').drawImage(im, 0, 0); await savePng(`${name}-crop`, cv); return; }

  // Camera: three-quarter view from the side the inspection camera did not see best (back-left of it).
  const box = new THREE.Box3().setFromObject(gt), target = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2;
  const az = Math.atan2(inspection.position.x - target.x, inspection.position.z - target.z) + (params.get('side') === 'front' ? 0.6 : Math.PI - 0.7);
  const camera = new PhysicalCamera(30, W / H, 0.02, 20);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.1, elev = THREE.MathUtils.degToRad(30);
  camera.position.set(target.x + dist * Math.cos(elev) * Math.sin(az), target.y + dist * Math.sin(elev), target.z + dist * Math.cos(elev) * Math.cos(az));
  camera.lookAt(target); camera.focusDistance = dist; camera.fStop = 3.5; camera.apertureBlades = 7; camera.updateMatrixWorld(true);
  const softbox = new THREE.RectAreaLight('#fff4e6', 9, 0.9, 0.9);
  softbox.position.set(target.x + 0.9, target.y + 1.4, target.z + 1.0); softbox.lookAt(target); scene.add(softbox);

  renderer.setSize(W, H, false);
  const pt = new WebGLPathTracer(renderer);
  Object.assign(pt, { renderDelay: 0, fadeDuration: 0, minSamples: 0, bounces: 6, filterGlossyFactor: 1, rasterizeScene: false });
  pt.tiles.set(4, 4);
  const trace = async (objects) => {
    objects.forEach((o) => scene.add(o));
    renderer.setSize(W, H, false);
    pt.setScene(scene, camera);
    while (pt.isCompiling) await tick();
    pt.renderSample();
    pt._pathTracer.material.seed += Number(chunk ?? 0) * spp * 7919;
    const gl = renderer.getContext(); let k = 0;
    while (pt.samples < spp && !gl.isContextLost()) { pt.renderSample(); if (++k % 8 === 0) await tick(); }
    const out = canvasOf(W, H); out.getContext('2d').drawImage(renderer.domElement, 0, 0);
    if (gl.isContextLost()) { window.__lost = true; throw new Error('WebGL context lost'); }
    objects.forEach((o) => scene.remove(o));
    return out;
  };
  const rgba = (copy) => copy.traverse((m) => { const a = m.isMesh && m.geometry.attributes.color; if (!a || a.itemSize === 4) return; const x = new Float32Array(a.count * 4).fill(1); for (let i = 0; i < a.count; i++) x.set([a.getX(i), a.getY(i), a.getZ(i)], 4 * i); m.geometry.setAttribute('color', new THREE.BufferAttribute(x, 4)); });
  const copyOf = () => { const cp = placed.clone(true); cp.traverse((m) => { if (m.isMesh) m.geometry = m.geometry.clone(); }); return cp; };
  const suffix = chunk !== null ? `-c${chunk}` : '';
  if (pass === 'coverage') {
    const cov = computeCoverage(placed, [inspection], { occluders: [cell], samples: 6000 });
    const q = [...cov.perMesh.values()];
    const cp = copyOf();
    const obsC = new THREE.Color('#9fd8c2'), infC = new THREE.Color('#d8d4cf');
    meshesOf(cp).forEach((m, k) => { const col = new Float32Array(q[k].length * 3); q[k].forEach((v, i) => (v > 0 ? obsC : infC).toArray(col, 3 * i)); m.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3)); m.geometry.setAttribute('observation', new THREE.BufferAttribute(q[k], 1)); m.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide }); });
    rgba(cp);
    const img = await trace([cp]);
    hatch(img, inferredMask(cp, camera, W, H), (W / 1600) * (16 / 9));
    await savePng(`${name}-coverage${suffix}`, img);
  } else if (pass === 'deviation') {
    const dev = computeDeviation(placed, gt, 6000);
    const cp = copyOf(); const dv = [...dev.perMesh.values()];
    meshesOf(cp).forEach((m, k) => applyDeviationShading(m, dv[k], 0.003)); rgba(cp);
    await savePng(`${name}-deviation${suffix}`, await trace([cp]));
  } else {
    await savePng(`${name}-groundtruth${suffix}`, await trace([gt]));
  }
}

function inferredMask(object, camera, W, H) {
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const maskMat = new THREE.ShaderMaterial({ side: THREE.DoubleSide,
    vertexShader: 'attribute float observation; varying float vObs; void main() { vObs = observation; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float vObs; void main() { gl_FragColor = vec4(vec3(1.0 - smoothstep(0.0, 0.05, vObs)), 1.0); }' });
  const saved = new Map(); scene.add(object);
  scene.traverse((m) => { if (m.isMesh) { saved.set(m, m.material); m.material = black; } });
  object.traverse((m) => { if (m.isMesh) m.material = maskMat; });
  const bg = scene.background, tm = renderer.toneMapping;
  scene.background = new THREE.Color(0x000000); renderer.toneMapping = THREE.NoToneMapping;
  renderer.setSize(W * 2, H * 2, false); renderer.setRenderTarget(null); renderer.render(scene, camera);
  const c = canvasOf(W, H); c.getContext('2d').drawImage(renderer.domElement, 0, 0, W * 2, H * 2, 0, 0, W, H);
  saved.forEach((mat, m) => { m.material = mat; }); scene.remove(object);
  scene.background = bg; renderer.toneMapping = tm; renderer.setSize(W, H, false);
  return c.getContext('2d').getImageData(0, 0, W, H).data;
}
function hatch(canvas, mask, scale) {
  const ctx = canvas.getContext('2d'); const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data, w = canvas.width;
  const spacing = 9 * scale, col = [0xd0, 0x66, 0x2f], sub = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  for (let k = 0; k < d.length / 4; k++) {
    const m = mask[4 * k] / 255; if (m <= 0) continue;
    const x = k % w, y = (k / w) | 0;
    const a = sub.reduce((s, [ox, oy]) => s + (((x + ox + y + oy) / spacing) % 1 >= 0.62 ? 1 : 0), 0) / sub.length * 0.75 * m; if (a <= 0) continue;
    const l = (0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2]) / 255, sh = Math.min(1.08, Math.max(0.4, l / 0.8));
    for (let c = 0; c < 3; c++) d[4 * k + c] = d[4 * k + c] * (1 - a) + col[c] * sh * a;
  }
  ctx.putImageData(img, 0, 0);
}

try { await main(); window.__done = true; } catch (e) { log(`Error: ${e.message}`); window.__failed = true; }
if (window.parent !== window) window.parent.postMessage({ bench: window.__done && !window.__lost ? 'done' : 'failed' }, '*');

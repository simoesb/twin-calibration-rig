// Figure studio page: loads the demo-twin GLBs, lights them like the platform's
// DemoCell scene (HDR environment, warm key light with soft shadows, cool fill) with
// Khronos PBR Neutral tone mapping (true product colours)
// plus ground-truth ambient occlusion, and renders each shot off screen at print
// resolution. `?shot=<name>` renders one shot, `?all=1` every shot; each PNG is
// POSTed to the studio server (/save/<name>).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Declared size of the Bracket (its AAS TechnicalData). */
const DECLARED = { W: 0.12, H: 0.08, D: 0.05 };
/** Where and how the bracket draft sits: on the inspection plate, scaled so its width matches. */
const DRAFT = { position: [1.28, 0.83, 0.01], rotationY: -0.55 };

/** The cell's flow, as numbered steps for the `flow` shot (world anchor points; label offset in px at 2400 wide). */
const FLOW = [
  { at: [-0.8, 0.5, 0],     title: 'Carrier arrives',   sub: 'conveyor · live AAS position',    label: [0, 82] },
  { at: [0.8, 0.62, 0],     title: 'Robot picks',       sub: 'carrier at the end stop',         label: [0, 82] },
  { at: [1.28, 0.95, 0.01], title: 'Inspection',        sub: 'reconstruction vs declared size', label: [-60, -150] },
  { at: [1.63, 0.9, 0.06],  title: 'Output tray',       sub: 'accepted parts',                  label: [210, -40] },
];

// carrierX 1.6 = the carrier at the end stop, where the robot picks.
const SHOTS = {
  hero:    { size: [2400, 1350], cam: [-2.9, 2.3, 3.9],    target: [0.45, 0.45, 0],    fov: 30, carrierX: 1.6 },
  flow:    { size: [2400, 1350], cam: [-2.9, 2.3, 3.9],    target: [0.45, 0.45, 0],    fov: 30, carrierX: 1.6, ghosts: [0], flow: true },
  plan:    { size: [2400, 1640], cam: [0.2, 8, 0.0001],    target: [0.2, 0, 0],        ortho: 1.42, carrierX: 1.6 },
  station: { size: [2000, 1400], cam: [0.3, 1.5, 1.4],     target: [1.12, 0.62, -0.12], fov: 36, carrierX: 1.6 },
  carrier: { size: [2000, 1400], cam: [-1.3, 0.8, 0.75],   target: [-0.8, 0.44, 0],    fov: 28 },
  motion:  { size: [2400, 1200], cam: [-0.15, 1.55, 2.7],  target: [0.1, 0.38, 0],     fov: 32, carrierX: 1.6, ghosts: [0, 0.4, 0.8, 1.2], motionArrow: true },
  bracket: { size: [2000, 1500], cam: [1.19, 0.975, 0.32], target: [1.28, 0.875, 0.005], fov: 24, annotate: true, carrierX: 1.6 },
};

const params = new URLSearchParams(location.search);
const BG = params.get('bg') ?? '#f3f5f7';
const log = (s) => { document.getElementById('log').textContent += `${s}\n`; console.log(s); };

// ── Scene ───────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.environmentIntensity = 0.9;

const key = new THREE.DirectionalLight('#fff1e0', 3.2);
key.position.set(2.8, 4.6, 3.4);
key.target.position.set(0.4, 0, 0);
key.castShadow = true;
key.shadow.mapSize.set(4096, 4096);
Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 14 });
key.shadow.radius = 5;
key.shadow.blurSamples = 16;
key.shadow.bias = -0.0003;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight('#d6e2ff', 0.5);
fill.position.set(-3, 2.5, -2.5);
scene.add(fill);

const gltf = new GLTFLoader();
const [cellGltf, draftGltf, env] = await Promise.all([
  gltf.loadAsync('/assets/democell.glb'),
  gltf.loadAsync('/assets/bracket-draft.glb'),
  new HDRLoader().loadAsync('/hdr/empty_warehouse_01_1k.hdr'),
]);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(env).texture;

const cell = cellGltf.scene;
const draft = draftGltf.scene;
for (const o of [cell, draft]) o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
const draftSize = new THREE.Box3().setFromObject(draft).getSize(new THREE.Vector3());
const draftScale = DECLARED.W / draftSize.x;
draft.position.set(...DRAFT.position);
draft.rotation.y = DRAFT.rotationY;
draft.scale.setScalar(draftScale);
scene.add(cell, draft);

const carrier = cell.getObjectByName('Carrier');
const carrierBase = carrier.position.x;
const ghosts = new THREE.Group();
scene.add(ghosts);

/** Moves the carrier (as the live binding would) and lays out translucent earlier positions. */
function setCarrier(x = 0, ghostXs = []) {
  carrier.position.x = carrierBase + x;
  ghosts.clear();
  ghostXs.forEach((gx, i) => {
    const g = carrier.clone(true);
    g.position.x = carrierBase + gx;
    const opacity = 0.18 + 0.22 * (i / Math.max(1, ghostXs.length - 1));
    const echo = new THREE.MeshStandardMaterial({ color: '#7fb3ff', emissive: '#2f6fd1', emissiveIntensity: 0.25, roughness: 0.6, transparent: true, opacity, depthWrite: false });
    g.traverse((m) => {
      if (!m.isMesh) return;
      m.material = echo;
      m.castShadow = false;
    });
    ghosts.add(g);
  });
}

// ── Annotation (bracket shot) ───────────────────────────────────────────────
function annotate(ctx, camera, w, h) {
  const box = new THREE.Box3().setFromObject(draft.children[0], true);
  // Work in the draft's own frame so the callouts follow its edges.
  draft.updateMatrixWorld(true);
  const local = new THREE.Box3();
  draft.traverse((m) => { if (m.isMesh) { m.geometry.computeBoundingBox(); local.union(m.geometry.boundingBox); } });
  const P = (x, y, z) => draft.localToWorld(new THREE.Vector3(x, y, z));
  const S = (v) => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * w, (1 - p.y) / 2 * h]; };
  const { min, max } = local;
  const off = (max.x - min.x) * 0.12;
  const measured = { W: (max.x - min.x) * draftScale, H: (max.y - min.y) * draftScale, D: (max.z - min.z) * draftScale };
  const lines = [
    { k: 'W', a: P(min.x, min.y, max.z + off), b: P(max.x, min.y, max.z + off) },
    { k: 'H', a: P(min.x - off, min.y, min.z), b: P(min.x - off, max.y, min.z) },
    { k: 'D', a: P(max.x + off, min.y, min.z), b: P(max.x + off, min.y, max.z) },
  ];
  const s = w / 2000;
  ctx.lineCap = 'round';
  for (const { k, a, b } of lines) {
    const dev = measured[k] / DECLARED[k] - 1;
    const color = Math.abs(dev) > 0.05 ? '#d64545' : Math.abs(dev) > 0.02 ? '#e0a020' : '#14a37f';
    const [ax, ay] = S(a), [bx, by] = S(b);
    ctx.strokeStyle = color; ctx.lineWidth = 4 * s;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    const nx = -(by - ay), ny = bx - ax, nl = Math.hypot(nx, ny) || 1;
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      ctx.beginPath(); ctx.moveTo(x - nx / nl * 12 * s, y - ny / nl * 12 * s); ctx.lineTo(x + nx / nl * 12 * s, y + ny / nl * 12 * s); ctx.stroke();
    }
    const label = `${k}  ${(measured[k] * 1000).toFixed(1)} mm`;
    const sub = `declared ${(DECLARED[k] * 1000).toFixed(0)} mm · ${dev >= 0 ? '+' : ''}${(dev * 100).toFixed(1)} %`;
    ctx.font = `600 ${30 * s}px system-ui, sans-serif`;
    const tw = Math.max(ctx.measureText(label).width, (ctx.font = `${24 * s}px system-ui, sans-serif`, ctx.measureText(sub).width));
    const cx = (ax + bx) / 2 + nx / nl * 70 * s * (k === 'W' ? -1 : 1), cy = (ay + by) / 2 + ny / nl * 70 * s * (k === 'W' ? -1 : 1);
    const pw = tw + 36 * s, ph = 84 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = color; ctx.lineWidth = 3 * s;
    ctx.beginPath(); ctx.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, 12 * s); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1d2329'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${30 * s}px system-ui, sans-serif`; ctx.fillText(label, cx, cy - 15 * s);
    ctx.fillStyle = color; ctx.font = `${24 * s}px system-ui, sans-serif`; ctx.fillText(sub, cx, cy + 20 * s);
  }
  return { box, measured };
}

// ── Annotation (motion shot) ────────────────────────────────────────────────
function motionArrow(ctx, camera, w, h, fromX, toX) {
  const S = (x, y, z) => { const p = new THREE.Vector3(x, y, z).project(camera); return [(p.x + 1) / 2 * w, (1 - p.y) / 2 * h]; };
  const y = 0.56, z = 0.0, s = w / 2400;
  const [ax, ay] = S(carrierBase + fromX - 0.1, y, z), [bx, by] = S(carrierBase + toX + 0.02, y, z);
  const ang = Math.atan2(by - ay, bx - ax);
  ctx.strokeStyle = '#2f6fd1'; ctx.fillStyle = '#2f6fd1'; ctx.lineWidth = 6 * s; ctx.lineCap = 'round';
  ctx.setLineDash([18 * s, 14 * s]);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx - Math.cos(ang) * 26 * s, by - Math.sin(ang) * 26 * s); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - Math.cos(ang - 0.45) * 34 * s, by - Math.sin(ang - 0.45) * 34 * s);
  ctx.lineTo(bx - Math.cos(ang + 0.45) * 34 * s, by - Math.sin(ang + 0.45) * 34 * s);
  ctx.closePath(); ctx.fill();
  const label = 'Conveyor · Operation.Position (live)';
  const sub = `AAS value → Carrier translate x · ${fromX.toFixed(1)} → ${toX.toFixed(1)} m`;
  const cx = (ax + bx) / 2, cy = (ay + by) / 2 - 70 * s;
  ctx.font = `600 ${30 * s}px system-ui, sans-serif`;
  const tw = Math.max(ctx.measureText(label).width, (ctx.font = `${24 * s}px system-ui, sans-serif`, ctx.measureText(sub).width));
  const pw = tw + 40 * s, ph = 86 * s;
  ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.strokeStyle = '#2f6fd1'; ctx.lineWidth = 3 * s;
  ctx.beginPath(); ctx.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, 14 * s); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1d2329'; ctx.font = `600 ${30 * s}px system-ui, sans-serif`; ctx.fillText(label, cx, cy - 15 * s);
  ctx.fillStyle = '#2f6fd1'; ctx.font = `${24 * s}px system-ui, sans-serif`; ctx.fillText(sub, cx, cy + 20 * s);
}

// ── Annotation (flow shot) ──────────────────────────────────────────────────
function flowSteps(ctx, camera, w, h) {
  const s = w / 2400;
  const pts = FLOW.map(({ at }) => { const p = new THREE.Vector3(...at).project(camera); return [(p.x + 1) / 2 * w, (1 - p.y) / 2 * h]; });
  // Dashed arrows between consecutive steps, curved upward.
  ctx.strokeStyle = '#14a37f'; ctx.fillStyle = '#14a37f'; ctx.lineWidth = 5 * s; ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const cx = (ax + bx) / 2, cy = Math.min(ay, by) - 90 * s;
    const r = 30 * s;
    // Shorten both ends so the arrow stops at the badges.
    const t0 = r / Math.hypot(cx - ax, cy - ay), t1 = (r + 6 * s) / Math.hypot(bx - cx, by - cy);
    const sx = ax + (cx - ax) * t0, sy = ay + (cy - ay) * t0, ex = bx - (bx - cx) * t1, ey = by - (by - cy) * t1;
    ctx.setLineDash([16 * s, 12 * s]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(ey - cy, ex - cx);
    ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.45) * 26 * s, ey - Math.sin(ang - 0.45) * 26 * s);
    ctx.lineTo(ex - Math.cos(ang + 0.45) * 26 * s, ey - Math.sin(ang + 0.45) * 26 * s);
    ctx.closePath(); ctx.fill();
  }
  FLOW.forEach(({ title, sub, label }, i) => {
    const [x, y] = pts[i];
    ctx.fillStyle = '#14a37f'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5 * s;
    ctx.beginPath(); ctx.arc(x, y, 30 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${32 * s}px system-ui, sans-serif`; ctx.fillText(String(i + 1), x, y + 1 * s);
    ctx.font = `600 ${28 * s}px system-ui, sans-serif`;
    const tw = Math.max(ctx.measureText(title).width, (ctx.font = `${22 * s}px system-ui, sans-serif`, ctx.measureText(sub).width));
    const pw = tw + 36 * s, ph = 78 * s, px = x + label[0] * s, py = y + label[1] * s;
    ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.strokeStyle = '#14a37f'; ctx.lineWidth = 3 * s;
    ctx.beginPath(); ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, 12 * s); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1d2329'; ctx.font = `600 ${28 * s}px system-ui, sans-serif`; ctx.fillText(title, px, py - 14 * s);
    ctx.fillStyle = '#4a5560'; ctx.font = `${22 * s}px system-ui, sans-serif`; ctx.fillText(sub, px, py + 18 * s);
  });
}

// ── Render ──────────────────────────────────────────────────────────────────
async function render(name) {
  const shot = SHOTS[name];
  if (!shot) throw new Error(`unknown shot ${name}`);
  const [w, h] = shot.size;
  renderer.setSize(w, h, false);
  const camera = shot.ortho
    ? new THREE.OrthographicCamera(-shot.ortho * w / h, shot.ortho * w / h, shot.ortho, -shot.ortho, 0.02, 50)
    : new THREE.PerspectiveCamera(shot.fov, w / h, 0.02, 50);
  camera.position.set(...shot.cam);
  camera.lookAt(...shot.target);
  setCarrier(shot.carrierX ?? 0, shot.ghosts ?? []);

  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, w, h);
  ao.updateGtaoMaterial({ radius: 0.18, distanceExponent: 1.5, thickness: 1.2, scale: 1.1 });
  ao.blendIntensity = 0.9;
  composer.addPass(ao);
  composer.addPass(new OutputPass());
  composer.render();

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(renderer.domElement, 0, 0);
  if (shot.annotate) annotate(ctx, camera, w, h);
  if (shot.motionArrow) motionArrow(ctx, camera, w, h, shot.ghosts[0], shot.carrierX);
  if (shot.flow) flowSteps(ctx, camera, w, h);
  const r = await fetch(`/save/${name}`, { method: 'POST', body: out.toDataURL('image/png') });
  composer.dispose(); rt.dispose();
  log(`${name}: ${w}×${h} ${r.ok ? 'saved' : `save failed (${r.status})`}`);
}

const names = params.get('all') ? Object.keys(SHOTS) : [params.get('shot') ?? 'hero'];
for (const n of names) await render(n);
window.__done = names;

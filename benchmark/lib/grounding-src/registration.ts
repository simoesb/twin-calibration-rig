/**
 * Camera-grounded registration of a generated model: estimate its pose and metric
 * scale in the twin by analysis-by-synthesis — render its silhouette from the
 * twin's calibrated camera(s) and maximise overlap (IoU) with the object's mask in
 * the camera image(s), using CMA-ES.
 *
 * A single silhouette leaves scale and depth ambiguous. The twin supplies what
 * resolves it: the support surface the part rests on (`supportY`, fixing height
 * and tilt: 4 DoF x, z, yaw, scale) and, optionally, the asset's declared overall
 * size from its AAS (a soft scale prior on the model's longest dimension). The
 * model's longest dimension is measured as the larger of its height and the long
 * side of its minimum-area footprint rectangle, so it does not change with the
 * generator's choice of yaw; the generator's up axis is assumed to be +Y, as glTF
 * specifies. Without a support the full 7 DoF are
 * estimated. Known scene geometry in front of the part (`occluders`) is rendered
 * depth-only, so a partly hidden part is matched against its visible silhouette.
 *
 * Runs on the GPU in the browser (WebGL); a 256-pixel render + read-back is about
 * a millisecond, so a few hundred evaluations take a second or two.
 *
 * @module scene/grounding/registration
 */

import * as THREE from "three";
import { cmaes } from "./cmaes";

export interface RegistrationView {
  /** The twin camera (pose + intrinsics) the mask was taken from. */
  camera: THREE.PerspectiveCamera;
  /** Object mask, row-major from the top-left, `width × height`, non-zero = object. */
  mask: Uint8Array;
  width: number;
  height: number;
}

export interface Pose {
  position: [number, number, number];
  /** Euler XYZ (radians). */
  rotation: [number, number, number];
  scale: number;
}

export interface RegistrationOptions {
  /** Height of the support surface the part rests on; enables the 4-DoF mode. */
  supportY?: number;
  /** Declared overall size (longest dimension, world units) — a soft scale prior. */
  declaredSize?: number;
  /** Weight of the declared-size prior (default 0.5 — one log-unit off costs half an IoU). */
  priorWeight?: number;
  /** Scene geometry that can hide the part (rendered depth-only). */
  occluders?: THREE.Object3D[];
  /** Yaw starts for the multi-start search (radians). Default 0, 90, 180, 270°. */
  yawStarts?: number[];
  /** Evaluations per start / for the final refinement. Default 120 / 360. */
  startEvals?: number;
  refineEvals?: number;
  seed?: number;
  /** Search only from this pose, with `refineEvals` evaluations (diagnostics, e.g. starting at the true pose). */
  init?: Pose;
  /** Initial CMA-ES step, relative to the parameter scales, when starting from `init` (default 0.05). */
  initSigma?: number;
}

export interface RegistrationResult extends Pose {
  /** IoU per view at the solution. */
  iou: number[];
  evals: number;
  ms: number;
}

/** Normalised copy of `model`: origin at its bottom centre, unit transform. */
function normalised(model: THREE.Object3D): { root: THREE.Group; inner: THREE.Object3D; box: THREE.Box3 } {
  const inner = model.clone(true);
  inner.position.set(0, 0, 0); inner.rotation.set(0, 0, 0); inner.scale.set(1, 1, 1);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const root = new THREE.Group();
  root.add(inner);
  return { root, inner, box };
}

/** Convex hull (counter-clockwise) of 2-D points, Andrew's monotone chain. */
function convexHull(xs: Float64Array, zs: Float64Array): [number, number][] {
  const idx = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b] || zs[a] - zs[b]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (order: number[]) => {
    const h: [number, number][] = [];
    for (const i of order) {
      const p: [number, number] = [xs[i], zs[i]];
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...half(idx), ...half([...idx].reverse())];
}

/**
 * Longest dimension of an upright model: the larger of its height and the long side
 * of its minimum-area footprint rectangle (rotating calipers over the convex hull of
 * its vertices projected on the ground plane). Unchanged by rotation about +Y.
 */
export function longestDimension(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const pts: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  const v = new THREE.Vector3();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      pts.push(v.x, v.z);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
  });
  const n = pts.length / 2;
  const xs = new Float64Array(n), zs = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = pts[2 * i]; zs[i] = pts[2 * i + 1]; }
  const hull = convexHull(xs, zs);
  let best = { area: Infinity, long: 0 };
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len === 0) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [px, pz] of hull) {
      const u = px * ux + pz * uz, w = -px * uz + pz * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, w); maxV = Math.max(maxV, w);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) best = { area, long: Math.max(maxU - minU, maxV - minV) };
  }
  return Math.max(best.long, maxY - minY);
}

const WHITE = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const DEPTH_ONLY = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

/** Scene that renders `target` white and `occluders` depth-only on black. */
function maskScene(target: THREE.Object3D, occluders: THREE.Object3D[] = []): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const t = target;
  t.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = WHITE; });
  scene.add(t);
  for (const occ of occluders) {
    const c = occ.clone(true);
    occ.updateMatrixWorld(true);
    c.matrixAutoUpdate = false;
    c.matrix.copy(occ.matrixWorld);
    c.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).material = DEPTH_ONLY; (o as THREE.Mesh).renderOrder = -1; } });
    scene.add(c);
  }
  return scene;
}

/** Render a binary mask (row-major from the top-left) of `scene` from `camera`. */
export function renderMask(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, target?: THREE.WebGLRenderTarget): Uint8Array {
  const rt = target ?? new THREE.WebGLRenderTarget(width, height);
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);
  const rgba = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, rgba);
  renderer.setRenderTarget(prevTarget);
  if (!target) rt.dispose();
  // WebGL reads bottom-up; flip to top-left origin.
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width, dst = y * width;
    for (let x = 0; x < width; x++) mask[dst + x] = rgba[4 * (src + x)] > 127 ? 1 : 0;
  }
  return mask;
}

/** Mask of `object` (as currently posed) from `camera`, with `occluders` hiding it. */
export function objectMask(renderer: THREE.WebGLRenderer, object: THREE.Object3D, camera: THREE.Camera, width: number, height: number, occluders: THREE.Object3D[] = []): Uint8Array {
  object.updateMatrixWorld(true);
  const c = object.clone(true);
  c.matrixAutoUpdate = false;
  c.matrix.copy(object.matrixWorld);
  return renderMask(renderer, maskScene(c, occluders), camera, width, height);
}

export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] ? 1 : 0, y = b[i] ? 1 : 0; inter += x & y; union += x | y; }
  return union ? inter / union : 0;
}

/** Centroid of a mask, back-projected through `camera` onto the plane y = `planeY`. */
export function maskCentroidOnPlane(view: RegistrationView, planeY: number): THREE.Vector3 | null {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) if (view.mask[y * view.width + x]) { sx += x; sy += y; n++; }
  if (!n) return null;
  const ndc = new THREE.Vector2(((sx / n + 0.5) / view.width) * 2 - 1, 1 - ((sy / n + 0.5) / view.height) * 2);
  const ray = new THREE.Raycaster();
  view.camera.updateMatrixWorld(true);
  ray.setFromCamera(ndc, view.camera);
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY), new THREE.Vector3());
}

/**
 * Estimate the pose and scale of `model` from its masks in `views`. Returns the
 * pose of the model's bottom centre; `applyPose` places a model there.
 */
export async function registerToSilhouettes(
  renderer: THREE.WebGLRenderer,
  model: THREE.Object3D,
  views: RegistrationView[],
  opts: RegistrationOptions = {},
): Promise<RegistrationResult> {
  const t0 = performance.now();
  const { root, inner } = normalised(model);
  const extent = longestDimension(inner);
  const scenes = views.map(() => maskScene(root.clone(true), opts.occluders));
  const pivots = scenes.map((s) => s.children[0] as THREE.Group);
  const targets = views.map((v) => new THREE.WebGLRenderTarget(v.width, v.height));
  const supported = opts.supportY !== undefined;

  // Initial position: mask centroid on the support plane (or on the camera axis 1.5 m out).
  const planeY = opts.supportY ?? 0;
  const c0 = maskCentroidOnPlane(views[0], planeY) ?? new THREE.Vector3();
  // Initial scale: declared size, else the mask's horizontal extent at the centroid's depth.
  let s0: number;
  if (opts.declaredSize) s0 = opts.declaredSize / extent;
  else {
    const v = views[0];
    let minX = v.width, maxX = 0;
    for (let i = 0; i < v.mask.length; i++) if (v.mask[i]) { const x = i % v.width; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    const dist = v.camera.position.distanceTo(c0);
    const pxPerUnit = v.height / (2 * dist * Math.tan(THREE.MathUtils.degToRad(v.camera.fov) / 2));
    s0 = Math.max(1e-4, (maxX - minX) / pxPerUnit / extent);
  }

  // Parameters: supported → [x, z, yaw, ln s]; free → [x, y, z, rx, yaw, rz, ln s].
  const toPose = (p: number[]): Pose => supported
    ? { position: [p[0], planeY, p[1]], rotation: [0, p[2], 0], scale: Math.exp(p[3]) }
    : { position: [p[0], p[1], p[2]], rotation: [p[3], p[4], p[5]], scale: Math.exp(p[6]) };
  const cost = (p: number[]) => {
    const pose = toPose(p);
    let sum = 0;
    views.forEach((v, i) => {
      applyPose(pivots[i], pose);
      sum += iou(renderMask(renderer, scenes[i], v.camera, v.width, v.height, targets[i]), v.mask);
    });
    let c = 1 - sum / views.length;
    if (opts.declaredSize) c += (opts.priorWeight ?? 0.5) * Math.log((pose.scale * extent) / opts.declaredSize) ** 2;
    return c;
  };

  const size = extent * s0;
  const scales = supported ? [size, size, 1, 0.3] : [size, size, size, 0.5, 1, 0.5, 0.3];
  const start = (yaw: number) => supported
    ? [c0.x, c0.z, yaw, Math.log(s0)]
    : [c0.x, c0.y + (size / 2), c0.z, 0, yaw, 0, Math.log(s0)];
  const fromPose = (q: Pose) => supported
    ? [q.position[0], q.position[2], q.rotation[1], Math.log(q.scale)]
    : [...q.position, ...q.rotation, Math.log(q.scale)];
  let best = { x: opts.init ? fromPose(opts.init) : start(0), value: Infinity, evals: 0 };
  let evals = 0;
  for (const yaw of opts.init ? [] : opts.yawStarts ?? [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const r = await cmaes(cost, start(yaw), { sigma: 0.5, scales, maxEvals: opts.startEvals ?? 120, seed: opts.seed });
    evals += r.evals;
    if (r.value < best.value) best = r;
  }
  const refined = await cmaes(cost, best.x, { sigma: opts.init ? opts.initSigma ?? 0.05 : 0.15, scales, maxEvals: opts.refineEvals ?? 360, seed: (opts.seed ?? 1) + 7 });
  evals += refined.evals;
  if (refined.value < best.value) best = refined;

  const pose = toPose(best.x);
  const ious = views.map((v, i) => {
    applyPose(pivots[i], pose);
    return iou(renderMask(renderer, scenes[i], v.camera, v.width, v.height, targets[i]), v.mask);
  });
  targets.forEach((t) => t.dispose());
  return { ...pose, iou: ious, evals, ms: performance.now() - t0 };
}

/**
 * Place a model so its bottom centre sits at `pose` (as returned by
 * `registerToSilhouettes`), whatever its own origin.
 */
export function applyPose(object: THREE.Object3D, pose: Pose): void {
  object.position.set(...pose.position);
  object.rotation.set(...pose.rotation);
  object.scale.setScalar(pose.scale);
  object.updateMatrixWorld(true);
}

/** Pose that places `model` (any origin) with its bottom centre at `pose`: wraps it in a group. */
export function poseModel(model: THREE.Object3D, pose: Pose): THREE.Group {
  const { root } = normalised(model);
  applyPose(root, pose);
  return root;
}

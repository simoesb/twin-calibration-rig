/**
 * Geometric deviation of a generated model from a reference (CAD, a scan, or a
 * parametric model built from declared dimensions): per-vertex signed distance
 * for shading, and area-uniform statistics in both directions (model → reference
 * measures invented or misplaced surface; reference → model measures missing
 * surface).
 *
 * @module scene/grounding/deviation
 */

import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { meshesOf, surfaceSamples, worldBVH, worldGeometry, worldVertices } from "./geometry";
import { observationAt, visibilityTolerance } from "./coverage";

export interface DistanceStats {
  mean: number;
  rms: number;
  p95: number;
  max: number;
}

export interface DeviationResult {
  /** Signed distance per vertex (positive outside the reference), per mesh. */
  perMesh: Map<THREE.Mesh, Float32Array>;
  /** Model → reference (invented / misplaced surface). */
  forward: DistanceStats;
  /** Reference → model (missing surface). */
  backward: DistanceStats;
  /** Symmetric Chamfer distance (mean of both means). */
  chamfer: number;
  /** Symmetric Hausdorff distance. */
  hausdorff: number;
}

export function stats(values: number[]): DistanceStats {
  if (!values.length) return { mean: NaN, rms: NaN, p95: NaN, max: NaN };
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
  const rms = Math.sqrt(abs.reduce((s, v) => s + v * v, 0) / abs.length);
  return { mean, rms, p95: abs[Math.min(abs.length - 1, Math.floor(0.95 * abs.length))], max: abs[abs.length - 1] };
}

const PARITY_DIR = new THREE.Vector3(1, 1.618, 2.718).normalize();

/**
 * Signed distance from `p` to the surface in `bvh` (positive outside). The sign
 * comes from the nearest face's normal; near edges and corners, where that normal
 * is nearly perpendicular to the offset, from ray parity instead.
 */
export function signedDistance(bvh: MeshBVH, geometry: THREE.BufferGeometry, p: THREE.Vector3): number {
  const hit = bvh.closestPointToPoint(p);
  if (!hit) return NaN;
  if (hit.distance < 1e-12) return 0;
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  // MeshBVH (re)builds an index over the geometry; faceIndex refers to it.
  const vertex = (k: number) => (geometry.index ? geometry.index.getX(3 * hit.faceIndex + k) : 3 * hit.faceIndex + k);
  const a = new THREE.Vector3().fromBufferAttribute(pos, vertex(0));
  const b = new THREE.Vector3().fromBufferAttribute(pos, vertex(1));
  const c = new THREE.Vector3().fromBufferAttribute(pos, vertex(2));
  const n = b.sub(a).cross(c.sub(a)).normalize();
  const cos = p.clone().sub(hit.point).dot(n) / hit.distance;
  if (Math.abs(cos) > 0.3) return Math.sign(cos) * hit.distance;
  const crossings = bvh.raycast(new THREE.Ray(p.clone(), PARITY_DIR), THREE.DoubleSide).length;
  return (crossings % 2 === 1 ? -1 : 1) * hit.distance;
}

/** Deviation of `model` from `reference`, both posed in world space. */
export function computeDeviation(model: THREE.Object3D, reference: THREE.Object3D, samples = 20000): DeviationResult {
  const ref = worldBVH(reference);
  const perMesh = new Map<THREE.Mesh, Float32Array>();
  for (const mesh of meshesOf(model)) {
    const { points } = worldVertices(mesh);
    perMesh.set(mesh, Float32Array.from(points, (p) => signedDistance(ref.bvh, ref.geometry, p)));
  }
  const modelGeo = worldGeometry(model);
  const modelBVH = worldBVH(model);
  const fwd = surfaceSamples(modelGeo, samples, 7).points.map((p) => signedDistance(ref.bvh, ref.geometry, p));
  const bwd = surfaceSamples(ref.geometry, samples, 11).points.map((p) => signedDistance(modelBVH.bvh, modelBVH.geometry, p));
  const forward = stats(fwd), backward = stats(bwd);
  return { perMesh, forward, backward, chamfer: (forward.mean + backward.mean) / 2, hausdorff: Math.max(forward.max, backward.max) };
}

export interface CoverageSplit {
  /** Deviation of model surface the cameras observed. */
  observed: DistanceStats & { fraction: number };
  /** Deviation of model surface the generator inferred. */
  inferred: DistanceStats & { fraction: number };
}

/**
 * Model → reference deviation split by observation: does the surface the input
 * camera never saw carry more error than the surface it did?
 */
export function deviationByCoverage(
  model: THREE.Object3D,
  reference: THREE.Object3D,
  cameras: THREE.Camera[],
  opts: { grazingDeg?: number; occluders?: THREE.Object3D[]; samples?: number } = {},
): CoverageSplit {
  cameras.forEach((c) => c.updateMatrixWorld(true));
  const ref = worldBVH(reference);
  const occ = worldBVH([model, ...(opts.occluders ?? [])]);
  const eps = visibilityTolerance(model);
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(opts.grazingDeg ?? 80));
  const s = surfaceSamples(worldGeometry(model), opts.samples ?? 20000, 3);
  const seen: number[] = [], unseen: number[] = [];
  s.points.forEach((p, i) => {
    const d = signedDistance(ref.bvh, ref.geometry, p);
    (observationAt(p, s.normals[i], cameras, occ.bvh, cosLimit, eps) > 0 ? seen : unseen).push(d);
  });
  const n = s.points.length;
  return {
    observed: { ...stats(seen), fraction: seen.length / n },
    inferred: { ...stats(unseen), fraction: unseen.length / n },
  };
}

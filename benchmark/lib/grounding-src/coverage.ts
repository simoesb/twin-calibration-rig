/**
 * Observation coverage: which surfaces of a generated model the input camera(s)
 * actually observed, and which the generator had to infer.
 *
 * A surface point counts as observed by a camera when it lies inside the view
 * frustum, faces the camera within a grazing limit, and is the first surface a
 * ray from the camera hits (the model itself and any declared occluders are
 * tested with a BVH). Its observation quality is the cosine between the surface
 * normal and the viewing direction, taken over all cameras.
 *
 * @module scene/grounding/coverage
 */

import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { meshesOf, surfaceSamples, worldBVH, worldGeometry, worldVertices } from "./geometry";

export interface CoverageOptions {
  /** Surfaces seen more obliquely than this (degrees from the normal) count as unobserved. Default 80. */
  grazingDeg?: number;
  /** Other scene objects that can hide the model from a camera. */
  occluders?: THREE.Object3D[];
  /** Surface samples used for the area-weighted fraction. Default 20 000. */
  samples?: number;
}

export interface CoverageResult {
  /** Observation quality per vertex (0 = inferred, else cosine to the best camera), per mesh. */
  perMesh: Map<THREE.Mesh, Float32Array>;
  /** Fraction of the surface area observed by at least one camera. */
  fraction: number;
  /** Total surface area (world units²). */
  area: number;
}

/** Observation quality of a world point with a world normal, from a set of cameras. */
export function observationAt(
  point: THREE.Vector3,
  normal: THREE.Vector3,
  cameras: THREE.Camera[],
  occlusion: MeshBVH,
  cosLimit: number,
  eps: number,
): number {
  let best = 0;
  const ndc = new THREE.Vector3(), toCam = new THREE.Vector3(), camPos = new THREE.Vector3();
  const ray = new THREE.Ray();
  for (const cam of cameras) {
    ndc.copy(point).project(cam);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1) continue;
    camPos.setFromMatrixPosition(cam.matrixWorld);
    toCam.subVectors(camPos, point);
    const dist = toCam.length();
    toCam.divideScalar(dist);
    // |cos|: generated meshes often have flipped normals; the ray test below already
    // guarantees the point is the first surface the camera sees.
    const facing = Math.abs(normal.dot(toCam));
    if (facing <= cosLimit || facing <= best) continue;
    // Visible when the first surface along the camera ray lies within `eps` of the
    // point itself: anything nearer to the camera hides it, including the front face
    // of a thin wall when `point` is on its back face.
    ray.origin.copy(camPos);
    ray.direction.copy(toCam).negate();
    const hit = occlusion.raycastFirst(ray, THREE.DoubleSide, 0, dist + eps);
    if (!hit || hit.distance >= dist - eps) best = facing;
  }
  return best;
}

/**
 * Visibility tolerance for `model`: 0.1 % of its own bounding-box diagonal. Local
 * to the model, so unrelated scene geometry cannot change it; small against wall
 * thicknesses, large against floating-point error at metre-scale coordinates.
 */
export function visibilityTolerance(model: THREE.Object3D): number {
  const geometry = worldGeometry(model);
  geometry.computeBoundingBox();
  return geometry.boundingBox!.getSize(new THREE.Vector3()).length() * 1e-3;
}

/** Per-vertex observation quality and the observed area fraction of `model` as seen by `cameras`. */
export function computeCoverage(model: THREE.Object3D, cameras: THREE.Camera[], opts: CoverageOptions = {}): CoverageResult {
  cameras.forEach((c) => c.updateMatrixWorld(true));
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(opts.grazingDeg ?? 80));
  const { bvh } = worldBVH([model, ...(opts.occluders ?? [])]);
  const eps = visibilityTolerance(model);

  const perMesh = new Map<THREE.Mesh, Float32Array>();
  for (const mesh of meshesOf(model)) {
    const { points, normals } = worldVertices(mesh);
    const q = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) q[i] = observationAt(points[i], normals[i], cameras, bvh, cosLimit, eps);
    perMesh.set(mesh, q);
  }

  const samples = surfaceSamples(worldGeometry(model), opts.samples ?? 20000);
  let observed = 0;
  samples.points.forEach((p, i) => {
    if (observationAt(p, samples.normals[i], cameras, bvh, cosLimit, eps) > 0) observed++;
  });
  return { perMesh, fraction: observed / samples.points.length, area: samples.area };
}

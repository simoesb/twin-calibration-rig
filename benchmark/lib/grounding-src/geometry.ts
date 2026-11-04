/**
 * World-space geometry helpers shared by coverage, deviation and registration:
 * merged world geometry, a BVH over it, and area-uniform surface samples.
 *
 * @module scene/grounding/geometry
 */

import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Meshes under `root` (including `root`), with up-to-date world matrices. */
export function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  root.updateWorldMatrix(true, true);
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry?.attributes?.position) out.push(m);
  });
  return out;
}

/** All meshes under the roots merged into one non-indexed world-space geometry (positions only). */
export function worldGeometry(roots: THREE.Object3D | THREE.Object3D[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    for (const m of meshesOf(root)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", m.geometry.attributes.position.clone());
      if (m.geometry.index) g.setIndex(m.geometry.index.clone());
      const flat = g.index ? g.toNonIndexed() : g;
      flat.applyMatrix4(m.matrixWorld);
      parts.push(flat);
    }
  }
  if (!parts.length) throw new Error("worldGeometry: no meshes");
  return parts.length === 1 ? parts[0] : mergeGeometries(parts);
}

/** BVH over the world geometry of `roots`. */
export function worldBVH(roots: THREE.Object3D | THREE.Object3D[]): { bvh: MeshBVH; geometry: THREE.BufferGeometry } {
  const geometry = worldGeometry(roots);
  return { bvh: new MeshBVH(geometry), geometry };
}

/** Area-uniform samples on a (non-indexed) world geometry, with their face normals. */
export function surfaceSamples(geometry: THREE.BufferGeometry, count: number, seed = 1): { points: THREE.Vector3[]; normals: THREE.Vector3[]; area: number } {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const tris = pos.count / 3;
  const cumulative = new Float64Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let area = 0;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, 3 * t); b.fromBufferAttribute(pos, 3 * t + 1); c.fromBufferAttribute(pos, 3 * t + 2);
    area += n.subVectors(c, b).cross(a.clone().sub(b)).length() / 2;
    cumulative[t] = area;
  }
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const points: THREE.Vector3[] = [], normals: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const r = rand() * area;
    let lo = 0, hi = tris - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < r) lo = mid + 1; else hi = mid; }
    a.fromBufferAttribute(pos, 3 * lo); b.fromBufferAttribute(pos, 3 * lo + 1); c.fromBufferAttribute(pos, 3 * lo + 2);
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    points.push(new THREE.Vector3().copy(a).addScaledVector(b.clone().sub(a), u).addScaledVector(c.clone().sub(a), v));
    normals.push(new THREE.Vector3().subVectors(b, a).cross(c.clone().sub(a)).normalize());
  }
  return { points, normals, area };
}

/** World position and normal of every vertex of `mesh` (normals from the mesh, else its faces). */
export function worldVertices(mesh: THREE.Mesh): { points: THREE.Vector3[]; normals: THREE.Vector3[] } {
  mesh.updateWorldMatrix(true, false);
  const geo = mesh.geometry;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const points: THREE.Vector3[] = [], normals: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
    normals.push(new THREE.Vector3().fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize());
  }
  return { points, normals };
}

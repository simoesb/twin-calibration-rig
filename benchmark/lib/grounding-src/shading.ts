/**
 * Evidence-aware shading for generated models:
 *
 * - **coverage**: observed surfaces keep their material; surfaces the input
 *   camera never saw are desaturated and hatched in screen space, so what the
 *   generator inferred is visible at a glance from any viewpoint.
 * - **deviation**: a diverging map of signed distance to the reference (blue =
 *   inside / missing material, white = on the reference, red = outside / excess),
 *   clamped at ± `range`.
 *
 * Both write per-vertex attributes, so they survive edits that do not change the
 * mesh and are cheap to render.
 *
 * @module scene/grounding/shading
 */

import * as THREE from "three";

/** Diverging blue–white–red colour for a value in [-1, 1]. */
export function diverging(t: number, out = new THREE.Color()): THREE.Color {
  const x = Math.max(-1, Math.min(1, t));
  const blue = new THREE.Color("#2166ac"), white = new THREE.Color("#f7f7f7"), red = new THREE.Color("#b2182b");
  return x < 0 ? out.copy(white).lerp(blue, -x) : out.copy(white).lerp(red, x);
}

/** Paint a mesh by signed deviation (world units), clamped at ± `range`. */
export function applyDeviationShading(mesh: THREE.Mesh, deviation: Float32Array, range: number): void {
  const geo = mesh.geometry;
  const colors = new Float32Array(deviation.length * 3);
  const c = new THREE.Color();
  deviation.forEach((d, i) => { diverging(Number.isFinite(d) ? d / range : 0, c); colors.set([c.r, c.g, c.b], 3 * i); });
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
}

export interface CoverageShadingOptions {
  /** Observation quality below which a surface counts as inferred (default 0 → any observation). */
  threshold?: number;
  /** Hatch stripe spacing in pixels (default 7). */
  spacing?: number;
  /** Tint of observed surfaces (default none). */
  observedTint?: THREE.ColorRepresentation;
  /** Colour of the hatch strokes on inferred surfaces. */
  hatchColor?: THREE.ColorRepresentation;
}

/** Shade a mesh by observation coverage (`quality` per vertex, from `computeCoverage`). */
export function applyCoverageShading(mesh: THREE.Mesh, quality: Float32Array, opts: CoverageShadingOptions = {}): void {
  mesh.geometry.setAttribute("observation", new THREE.BufferAttribute(quality, 1));
  const base = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  const material = (base?.isMeshStandardMaterial ? base.clone() : new THREE.MeshStandardMaterial({ color: 0xbfc5cc })) as THREE.MeshStandardMaterial;
  const threshold = opts.threshold ?? 0;
  const spacing = opts.spacing ?? 7;
  const hatch = new THREE.Color(opts.hatchColor ?? "#d0662f");
  const tint = opts.observedTint !== undefined ? new THREE.Color(opts.observedTint) : null;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uThreshold = { value: threshold };
    shader.uniforms.uSpacing = { value: spacing };
    shader.uniforms.uHatch = { value: hatch };
    shader.uniforms.uTint = { value: tint ?? new THREE.Color(1, 1, 1) };
    shader.uniforms.uUseTint = { value: tint ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float observation;\nvarying float vObservation;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObservation = observation;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vObservation;\nuniform float uThreshold;\nuniform float uSpacing;\nuniform vec3 uHatch;\nuniform vec3 uTint;\nuniform float uUseTint;")
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        float inferred = 1.0 - smoothstep(uThreshold, uThreshold + 0.05, vObservation);
        float luma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 muted = mix(gl_FragColor.rgb, vec3(luma) * 0.92 + 0.06, 0.85);
        float stripe = step(0.62, fract((gl_FragCoord.x + gl_FragCoord.y) / uSpacing));
        vec3 inferredColour = mix(muted, uHatch, stripe * 0.75);
        vec3 observedColour = mix(gl_FragColor.rgb, gl_FragColor.rgb * uTint, uUseTint * 0.35);
        gl_FragColor.rgb = mix(observedColour, inferredColour, inferred);`);
  };
  material.customProgramCacheKey = () => `coverage-${threshold}-${spacing}`;
  mesh.material = material;
}

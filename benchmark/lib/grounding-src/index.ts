/**
 * Grounding generated geometry in the twin: camera-registered pose and metric
 * scale (analysis-by-synthesis on silhouettes), observation coverage (what the
 * input camera saw vs what the generator inferred), deviation from a reference,
 * and shading that renders both on the model.
 *
 * Framework-free three.js: used by the platform viewer and by the paper's figure
 * studio / benchmark alike.
 *
 * @module scene/grounding
 */

export { meshesOf, worldGeometry, worldBVH, surfaceSamples, worldVertices } from "./geometry";
export { computeCoverage, observationAt, visibilityTolerance, type CoverageOptions, type CoverageResult } from "./coverage";
export { computeDeviation, deviationByCoverage, signedDistance, stats, type DeviationResult, type DistanceStats, type CoverageSplit } from "./deviation";
export { registerToSilhouettes, longestDimension, renderMask, objectMask, iou, maskCentroidOnPlane, applyPose, poseModel, type RegistrationView, type RegistrationOptions, type RegistrationResult, type Pose } from "./registration";
export { cmaes, type CmaesOptions, type CmaesResult } from "./cmaes";
export { applyCoverageShading, applyDeviationShading, diverging, type CoverageShadingOptions } from "./shading";
export { groundWithVerification, verifyCandidate, viewOrder, type PolicyView, type PolicyCandidate, type PolicyOptions, type PolicyDecision, type PolicyResult } from "./policy";

// Geometry and evidence types used by evidence.ts (subset of the twin's Geometry schema).

/**
 * @interface Transform
 * Transformation data for the geometry, including position, rotation, and scale.
 */
export interface Transform {
  /** Position of the geometry in 3D space */
  position?: [number, number, number];
  /** Rotation of the geometry */
  rotation?: [number, number, number];
  /** Scaling of the geometry */
  scale?: [number, number, number];
  /** Optional color of the geometry */
  color?: string;
}

 * What a check depended on when it was recorded. A check stays current only while
 * the geometry still matches: changing the mesh or its scale invalidates any shape
 * check; moving or rotating it invalidates only placement checks; colour,
 * visibility and other appearance edits invalidate nothing.
 */
export interface EvidenceDependencies {
  /** Mesh file the check was made on. */
  source: string;
  /** Scale at check time. */
  scale: [number, number, number];
  /** Position at check time (placement checks only). */
  position?: [number, number, number];
  /** Rotation at check time (placement checks only). */
  rotation?: [number, number, number];
  /** Version of the reference the check compared against, when it has one. */
  referenceVersion?: string;
}

/** What a check examines. */
export type EvidenceCheckKind = "dimension" | "feature" | "placement";

/**
 * One recorded check: a property of the geometry compared against a reference.
 * Its applicability (current / needs reassessment / unassessed) is derived on read
 * from `dependencies`, never stored; a current check may still show a large
 * discrepancy — current means "describes this geometry", not "passed".
 */
export interface EvidenceCheck {
  id: string;
  kind: EvidenceCheckKind;
  /** What was checked, e.g. `width`, `hole spacing`, `mounting hole present`. */
  property: string;
  /** Where the reference value comes from, e.g. `aas:<submodelId>#TechnicalData.Width`, `datasheet`, `CAD rev B`. */
  reference: string;
  /** Reference value (dimension checks). */
  referenceValue?: number;
  /** Value measured on the geometry (dimension checks), in `unit`. */
  measuredValue?: number;
  /** Unit of the values (e.g. `m`, `mm`). */
  unit?: string;
  /** Feature checks: whether the feature is present on the geometry. */
  present?: boolean;
  /** How it was measured, e.g. `distance-tool`, `bounding-box`, `external:<tool>`. */
  method: string;
  /** Measurement endpoints in the geometry's local frame, when measured interactively. */
  endpoints?: [number, number, number][];
  /** Who recorded it (`operator`, `agent`). */
  recordedBy?: string;
  recordedAt: number;
  note?: string;
  /** What the check depended on when recorded (see {@link EvidenceDependencies}). */
  dependencies: EvidenceDependencies;
}

/** Acceptance of a geometry for a declared, limited use. Never upgrades its evidence. */
export interface EvidenceAcceptance {
  /** The use it is accepted for, e.g. `visual-context`, `layout-planning`. */
  use: string;
  /** Short human-readable rationale. */
  rationale?: string;
  /** Checks the decision relied on. */
  checkIds: string[];
  decidedBy?: string;
  decidedAt: number;
}

/** Evidence recorded for a geometry. */
export interface GeometryEvidence {
  /** The use the geometry is intended for (what acceptance is being considered for). */
  declaredUse?: string;
  checks: EvidenceCheck[];
  /** The current acceptance, if any. */
  acceptance?: EvidenceAcceptance;
  /** Earlier acceptances, oldest first. */
  history?: EvidenceAcceptance[];
}

/**
 * @interface Geometry
 * Defines a geometry object with various properties.

/** The parts of a twin geometry the evidence rules read. */
export interface Geometry {
  source: string;
  transform?: Transform;
  evidence?: GeometryEvidence;
}

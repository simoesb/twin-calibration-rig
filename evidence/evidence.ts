/**
 * Evidence behind a geometry: recorded checks, whether each still applies to the
 * geometry as it is now, and acceptance for a declared use.
 *
 * Applicability is derived on read, never stored: a check is **current** while
 * the geometry still matches what the check depended on, **needs reassessment**
 * once it does not, and **unassessed** when nothing was measured. The rule is
 * deliberately small and conservative:
 *
 * | edit                          | dimension / feature check | placement check |
 * |-------------------------------|---------------------------|-----------------|
 * | colour, visibility, material  | current                   | current         |
 * | move / rotate                 | current                   | reassess        |
 * | scale                         | reassess                  | reassess        |
 * | mesh replaced                 | reassess                  | reassess        |
 * | reference revised             | reassess                  | reassess        |
 *
 * Re-measuring records a new check; a stale check never becomes current again by
 * relabelling. Accepting a geometry for a use never changes its checks or its
 * authoring status.
 *
 * @module scene/evidence/evidence
 */

import type {
  EvidenceAcceptance,
  EvidenceCheck,
  EvidenceCheckKind,
  EvidenceDependencies,
  Geometry,
  GeometryEvidence,
} from './geometry-types';

/** Whether a check describes the geometry as it is now. */
export type Applicability = 'current' | 'needs_reassessment' | 'unassessed';

/** The part of a geometry evidence depends on. */
export type EvidenceSubject = Pick<Geometry, 'source' | 'transform' | 'evidence'>;

/** Common uses a geometry is accepted for (free text is allowed too). */
export const DECLARED_USES = ['visual-context', 'layout-planning', 'collision-envelope', 'dimensional-inspection'] as const;

const vec = (v: readonly number[] | undefined, fallback: [number, number, number]): [number, number, number] =>
  v && v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : fallback;

/** Relative tolerance for comparing transform components (float noise from forms and round-trips). */
const EPS = 1e-6;
const sameVec = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= EPS * Math.max(1, Math.abs(x), Math.abs(b[i])));

/** The dependencies a new check of `kind` records for the geometry as it is now. */
export function dependenciesFor(
  geometry: EvidenceSubject,
  kind: EvidenceCheckKind,
  referenceVersion?: string,
): EvidenceDependencies {
  const t = geometry.transform ?? {};
  return {
    source: geometry.source,
    scale: vec(t.scale, [1, 1, 1]),
    ...(kind === 'placement' ? { position: vec(t.position, [0, 0, 0]), rotation: vec(t.rotation, [0, 0, 0]) } : {}),
    ...(referenceVersion ? { referenceVersion } : {}),
  };
}

/** Why a check needs reassessment, or `null` while it still applies. */
export function staleReason(
  check: EvidenceCheck,
  geometry: EvidenceSubject,
  referenceVersions: Record<string, string> = {},
): string | null {
  const d = check.dependencies;
  const t = geometry.transform ?? {};
  if (!d || d.source !== geometry.source) return 'mesh replaced';
  if (!sameVec(d.scale, vec(t.scale, [1, 1, 1]))) return 'scale changed';
  if (check.kind === 'placement') {
    if (!sameVec(d.position, vec(t.position, [0, 0, 0]))) return 'moved';
    if (!sameVec(d.rotation, vec(t.rotation, [0, 0, 0]))) return 'rotated';
  }
  const current = referenceVersions[check.reference];
  if (current !== undefined && d.referenceVersion !== current) return 'reference revised';
  return null;
}

/** Whether nothing was actually measured or observed for a check. */
const unmeasured = (c: EvidenceCheck): boolean =>
  c.kind === 'feature' ? c.present === undefined : !Number.isFinite(c.measuredValue as number);

/** Applicability of a check to the geometry as it is now. */
export function applicability(
  check: EvidenceCheck,
  geometry: EvidenceSubject,
  referenceVersions?: Record<string, string>,
): Applicability {
  if (unmeasured(check)) return 'unassessed';
  return staleReason(check, geometry, referenceVersions) ? 'needs_reassessment' : 'current';
}

/** Signed and relative discrepancy of a dimension check, when both values exist. */
export function discrepancy(check: EvidenceCheck): { signed: number; relative?: number } | null {
  const { measuredValue: m, referenceValue: r } = check;
  if (!Number.isFinite(m as number) || !Number.isFinite(r as number)) return null;
  const signed = (m as number) - (r as number);
  return { signed, ...(r !== 0 ? { relative: Math.abs(signed) / Math.abs(r as number) } : {}) };
}

/** A check with its derived state, as panels and agents present it. */
export interface CheckView extends EvidenceCheck {
  applicability: Applicability;
  staleReason?: string;
  discrepancy?: { signed: number; relative?: number };
}

/** Every check of a geometry with its applicability and discrepancy. */
export function viewChecks(geometry: EvidenceSubject, referenceVersions?: Record<string, string>): CheckView[] {
  return (geometry.evidence?.checks ?? []).map((c) => {
    const a = applicability(c, geometry, referenceVersions);
    const reason = a === 'needs_reassessment' ? staleReason(c, geometry, referenceVersions) ?? undefined : undefined;
    const d = discrepancy(c);
    return { ...c, applicability: a, ...(reason ? { staleReason: reason } : {}), ...(d ? { discrepancy: d } : {}) };
  });
}

/** Counts of checks by applicability. */
export function summarize(
  geometry: EvidenceSubject,
  referenceVersions?: Record<string, string>,
): Record<Applicability, number> & { total: number } {
  const out = { current: 0, needs_reassessment: 0, unassessed: 0, total: 0 };
  for (const c of viewChecks(geometry, referenceVersions)) {
    out[c.applicability]++;
    out.total++;
  }
  return out;
}

/** Fields of a new check (dependencies, id and time are filled in). */
export type NewCheck = Omit<EvidenceCheck, 'id' | 'recordedAt' | 'dependencies'> & { referenceVersion?: string };

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Records a check against the geometry as it is now. Earlier checks are kept as
 * history: a re-measurement adds a check, it does not overwrite.
 */
export function recordCheck(geometry: EvidenceSubject, input: NewCheck, now = Date.now()): GeometryEvidence {
  const { referenceVersion, ...fields } = input;
  const check: EvidenceCheck = {
    ...fields,
    id: newId(),
    recordedAt: now,
    dependencies: dependenciesFor(geometry, input.kind, referenceVersion),
  };
  const evidence = geometry.evidence ?? { checks: [] };
  return { ...evidence, checks: [...(evidence.checks ?? []), check] };
}

/** Sets the use the geometry is intended for. */
export function declareUse(geometry: EvidenceSubject, use: string): GeometryEvidence {
  return { ...(geometry.evidence ?? { checks: [] }), declaredUse: use };
}

/**
 * Accepts the geometry for `use`, relying on its currently applicable checks. The
 * previous acceptance moves to history; checks and authoring status are unchanged.
 */
export function accept(
  geometry: EvidenceSubject,
  use: string,
  options: { rationale?: string; decidedBy?: string; now?: number; referenceVersions?: Record<string, string> } = {},
): GeometryEvidence {
  const evidence = geometry.evidence ?? { checks: [] };
  const acceptance: EvidenceAcceptance = {
    use,
    checkIds: viewChecks(geometry, options.referenceVersions)
      .filter((c) => c.applicability === 'current')
      .map((c) => c.id),
    ...(options.rationale ? { rationale: options.rationale } : {}),
    ...(options.decidedBy ? { decidedBy: options.decidedBy } : {}),
    decidedAt: options.now ?? Date.now(),
  };
  return {
    ...evidence,
    declaredUse: evidence.declaredUse ?? use,
    acceptance,
    history: evidence.acceptance ? [...(evidence.history ?? []), evidence.acceptance] : evidence.history,
  };
}

/** Whether the current acceptance still rests on checks that apply (false when none was relied on). */
export function acceptanceStillSupported(geometry: EvidenceSubject, referenceVersions?: Record<string, string>): boolean {
  const acceptance = geometry.evidence?.acceptance;
  if (!acceptance || acceptance.checkIds.length === 0) return false;
  const byId = new Map(viewChecks(geometry, referenceVersions).map((c) => [c.id, c]));
  return acceptance.checkIds.every((id) => byId.get(id)?.applicability === 'current');
}

/** The authoring status as it should be reported: an absent value is `unknown`, never `verified`. */
export const reportedStatus = (geometry: Pick<Geometry, 'verificationStatus'>): 'draft' | 'verified' | 'unknown' =>
  geometry.verificationStatus ?? 'unknown';

// Functional ablation of the implemented evidence-applicability rule: for each edit,
// the expected state of a dimension check, a feature check and a placement check is
// fixed beforehand; the real scene/evidence module is then run and compared.
import { recordCheck, viewChecks, accept, declareUse, acceptanceStillSupported } from './evidence';
type S = 'current' | 'needs_reassessment' | 'unassessed';
const base = () => ({ source: '/api/public/bracket-draft.glb', transform: { position: [1.28, 0.83, 0.01], rotation: [0, -0.55, 0], scale: [0.11675, 0.11675, 0.11675] } } as any);
const REF = 'aas:urn:demo-twin:sm:bracket-technicaldata';
function withChecks() {
  let g = base();
  g.evidence = recordCheck(g, { kind: 'dimension', property: 'Width', reference: `${REF}#Width`, referenceValue: 0.12, measuredValue: 0.12, unit: 'm', method: 'bounding-box-x', recordedBy: 'agent', referenceVersion: 'rev-1' } as any);
  g = { ...g }; g.evidence = recordCheck(g, { kind: 'feature', property: 'Mounting holes (2)', reference: `${REF}#HoleCount`, present: true, method: 'visual', recordedBy: 'operator', referenceVersion: 'rev-1' } as any);
  g = { ...g }; g.evidence = recordCheck(g, { kind: 'placement', property: 'Offset from plate datum', reference: 'cell-layout', referenceValue: 0, measuredValue: 0.002, unit: 'm', method: 'distance-tool', recordedBy: 'operator' } as any);
  g = { ...g }; g.evidence = declareUse(g, 'layout-planning');
  g = { ...g }; g.evidence = accept(g, 'layout-planning', { rationale: 'width within 1 %', decidedBy: 'operator' });
  return g;
}
const conditions: { name: string; edit: (g: any) => { g: any; refs?: Record<string, string> }; expect: [S, S, S] | null; supported?: boolean }[] = [
  { name: 'No evidence recorded', edit: () => ({ g: base() }), expect: null },
  { name: 'Checks recorded', edit: (g) => ({ g }), expect: ['current', 'current', 'current'], supported: true },
  { name: 'Colour edited', edit: (g) => ({ g: { ...g, material: { color: '#ff8800' } } }), expect: ['current', 'current', 'current'], supported: true },
  { name: 'Moved and rotated', edit: (g) => ({ g: { ...g, transform: { ...g.transform, position: [1.30, 0.83, 0.05], rotation: [0, 0.2, 0] } } }), expect: ['current', 'current', 'needs_reassessment'], supported: true },
  { name: 'Rescaled', edit: (g) => ({ g: { ...g, transform: { ...g.transform, scale: [0.15, 0.15, 0.15] } } }), expect: ['needs_reassessment', 'needs_reassessment', 'needs_reassessment'], supported: false },
  { name: 'Mesh replaced', edit: (g) => ({ g: { ...g, source: '/api/public/bracket-draft-v2.glb' } }), expect: ['needs_reassessment', 'needs_reassessment', 'needs_reassessment'], supported: false },
  { name: 'Reference revised', edit: (g) => ({ g, refs: { [`${REF}#Width`]: 'rev-2', [`${REF}#HoleCount`]: 'rev-2' } }), expect: ['needs_reassessment', 'needs_reassessment', 'current'], supported: false },
];
let agree = 0, total = 0;
const rows: any[] = [];
for (const c of conditions) {
  const { g, refs } = c.edit(withChecks());
  const views = viewChecks(g, refs);
  const got = views.map((v) => v.applicability) as S[];
  const reasons = views.map((v) => v.staleReason ?? '');
  const sup = g.evidence?.acceptance ? acceptanceStillSupported(g, refs) : undefined;
  if (c.expect) c.expect.forEach((e, i) => { total++; if (got[i] === e) agree++; });
  if (c.supported !== undefined) { total++; if (sup === c.supported) agree++; }
  rows.push({ condition: c.name, dimension: got[0] ?? 'unassessed', feature: got[1] ?? 'unassessed', placement: got[2] ?? 'unassessed', acceptanceSupported: sup ?? '—', reasons: [...new Set(reasons.filter(Boolean))].join('; '), expected: c.expect?.join('/') ?? 'no checks' });
}
console.table(rows);
console.log(JSON.stringify({ agree, total }));

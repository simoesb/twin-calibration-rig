/**
 * Evidence-driven regeneration: the twin decides from its own evidence whether a
 * generated, registered mesh can be accepted, and if not, which twin camera to
 * generate from next.
 *
 * Verification uses twin information only: the agreement of the registered mesh
 * with every camera's silhouette (minimum IoU) and, when the asset declares its
 * dimensions, the registered height and longest dimension against them. A failed
 * candidate triggers a new generation from the unused view whose object mask is
 * largest, up to a budget; the first verified candidate is accepted, otherwise the
 * best-agreeing one is returned flagged as unverified. Every decision is logged.
 *
 * The policy is independent of how candidates are produced: `evaluate(view)`
 * generates and registers (the benchmark replays a deterministic generator; a live
 * twin calls the reconstruction service).
 *
 * @module scene/grounding/policy
 */

/** A twin camera view the policy can generate from. */
export interface PolicyView {
  name: string;
  /** Object pixels in this view's mask (larger = better view of the object). */
  maskPixels: number;
}

/** A generated and registered candidate, as the policy sees it. */
export interface PolicyCandidate {
  /** Minimum IoU over all twin cameras after registration. */
  agreement: number;
  /** Registered height / declared height (when the asset declares it). */
  heightRatio?: number;
  /** Registered longest dimension / declared longest dimension. */
  longestRatio?: number;
}

export interface PolicyOptions {
  /** Agreement needed to accept (default 0.90). */
  tau?: number;
  /** Relative tolerance on declared dimensions (default 0.10). */
  dimTolerance?: number;
  /** Maximum generations (default 3). */
  budget?: number;
  /** View to try first (default: the largest mask). */
  first?: string;
}

export interface PolicyDecision {
  view: string;
  generated: boolean;
  agreement: number | null;
  heightRatio: number | null;
  longestRatio: number | null;
  verified: boolean;
  decision: string;
}

export interface PolicyResult<C> {
  /** The accepted candidate, or the best-agreeing one when none verified. */
  chosen: { view: string; candidate: C } | null;
  unverified: boolean;
  generations: number;
  decisions: PolicyDecision[];
}

/** Whether a candidate passes the twin's checks. */
export function verifyCandidate(c: PolicyCandidate, opts: PolicyOptions = {}): { verified: boolean; reason: string } {
  const tau = opts.tau ?? 0.9, tol = opts.dimTolerance ?? 0.1;
  if (!(c.agreement >= tau)) return { verified: false, reason: `agreement ${c.agreement.toFixed(3)} < ${tau}` };
  for (const [k, r] of [["height", c.heightRatio], ["longest dimension", c.longestRatio]] as const) {
    if (r !== undefined && Math.abs(r - 1) > tol) return { verified: false, reason: `${k} off by ${(Math.abs(r - 1) * 100).toFixed(1)} % (> ${tol * 100} %)` };
  }
  return { verified: true, reason: "agreement and declared dimensions within tolerance" };
}

/** Views in the order the policy tries them: `first`, then by decreasing mask size. */
export function viewOrder(views: PolicyView[], first?: string): PolicyView[] {
  const head = views.find((v) => v.name === first) ?? [...views].sort((a, b) => b.maskPixels - a.maskPixels)[0];
  return head ? [head, ...views.filter((v) => v !== head).sort((a, b) => b.maskPixels - a.maskPixels)] : [];
}

/** Run the policy: generate, register and verify, view by view, until a candidate verifies or the budget ends. */
export async function groundWithVerification<C extends PolicyCandidate>(
  views: PolicyView[],
  evaluate: (view: PolicyView) => Promise<C | null>,
  opts: PolicyOptions = {},
): Promise<PolicyResult<C>> {
  const order = viewOrder(views, opts.first).slice(0, opts.budget ?? 3);
  const decisions: PolicyDecision[] = [];
  const tried: { view: string; candidate: C }[] = [];
  for (const [k, view] of order.entries()) {
    const candidate = await evaluate(view);
    const last = k === order.length - 1;
    if (!candidate) {
      decisions.push({ view: view.name, generated: false, agreement: null, heightRatio: null, longestRatio: null, verified: false, decision: last ? "no mesh; budget or views exhausted" : "no mesh; try next view" });
      continue;
    }
    tried.push({ view: view.name, candidate });
    const v = verifyCandidate(candidate, opts);
    decisions.push({
      view: view.name, generated: true, agreement: candidate.agreement, heightRatio: candidate.heightRatio ?? null, longestRatio: candidate.longestRatio ?? null,
      verified: v.verified, decision: v.verified ? "accept" : last ? `reject (${v.reason}); budget or views exhausted` : `reject (${v.reason}); try next view`,
    });
    if (v.verified) return { chosen: { view: view.name, candidate }, unverified: false, generations: k + 1, decisions };
  }
  const best = [...tried].sort((a, b) => b.candidate.agreement - a.candidate.agreement)[0] ?? null;
  return { chosen: best, unverified: true, generations: order.length, decisions };
}

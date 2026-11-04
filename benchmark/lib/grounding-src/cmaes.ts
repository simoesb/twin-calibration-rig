/**
 * Compact CMA-ES (Hansen's (μ/μ_w, λ) evolution strategy with rank-one and
 * rank-μ covariance updates) for the small, derivative-free problems of
 * silhouette registration (4–7 parameters, a few hundred evaluations).
 * Deterministic for a given seed.
 *
 * @module scene/grounding/cmaes
 */

export interface CmaesOptions {
  /** Initial step size (in the units of `x0`, after `scales`). */
  sigma: number;
  /** Per-parameter scale, so one sigma means a comparable change in every parameter. */
  scales?: number[];
  /** Maximum objective evaluations. Default 400. */
  maxEvals?: number;
  /** Population size. Default 4 + 3 ln n. */
  lambda?: number;
  /** Stop when the best value is below this. */
  target?: number;
  seed?: number;
}

export interface CmaesResult {
  x: number[];
  value: number;
  evals: number;
}

/** Minimise `f` from `x0`. `f` may be async (e.g. a GPU render). */
export async function cmaes(f: (x: number[]) => number | Promise<number>, x0: number[], opts: CmaesOptions): Promise<CmaesResult> {
  const n = x0.length;
  const scales = opts.scales ?? x0.map(() => 1);
  const lambda = opts.lambda ?? 4 + Math.floor(3 * Math.log(n));
  const mu = Math.floor(lambda / 2);
  const rawW = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const wSum = rawW.reduce((a, b) => a + b, 0);
  const w = rawW.map((v) => v / wSum);
  const mueff = 1 / w.reduce((a, b) => a + b * b, 0);
  const cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
  const cs = (mueff + 2) / (n + mueff + 5);
  const c1 = 2 / ((n + 1.3) ** 2 + mueff);
  const cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff)) / ((n + 2) ** 2 + mueff));
  const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));

  let seed = (opts.seed ?? 1) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());

  // Work in normalised coordinates y = x / scales.
  let mean = x0.map((v, i) => v / scales[i]);
  let sigma = opts.sigma;
  let C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  let pc = new Array(n).fill(0), ps = new Array(n).fill(0);
  let B = C.map((r) => r.slice()), D = new Array(n).fill(1);
  let best: CmaesResult = { x: x0.slice(), value: Infinity, evals: 0 };
  let evals = 0, gen = 0;
  const maxEvals = opts.maxEvals ?? 400;

  while (evals < maxEvals) {
    const pop: { y: number[]; z: number[]; v: number }[] = [];
    for (let k = 0; k < lambda && evals < maxEvals; k++) {
      const z = Array.from({ length: n }, gauss);
      const bdz = B.map((row) => row.reduce((s, b, j) => s + b * D[j] * z[j], 0));
      const y = mean.map((m, i) => m + sigma * bdz[i]);
      const x = y.map((v, i) => v * scales[i]);
      const v = await f(x);
      evals++;
      pop.push({ y, z, v });
      if (v < best.value) best = { x, value: v, evals };
    }
    if (pop.length < mu) break;
    pop.sort((a, b) => a.v - b.v);
    if (opts.target !== undefined && best.value <= opts.target) break;

    const old = mean;
    mean = Array.from({ length: n }, (_, i) => pop.slice(0, mu).reduce((s, p, k) => s + w[k] * p.y[i], 0));
    const step = mean.map((m, i) => (m - old[i]) / sigma);
    // C^{-1/2} * step = B D^{-1} B^T step
    const btStep = B[0].map((_, j) => B.reduce((s, row, i) => s + row[j] * step[i], 0));
    const invsqrt = B.map((row) => row.reduce((s, b, j) => s + (b * btStep[j]) / D[j], 0));
    ps = ps.map((p, i) => (1 - cs) * p + Math.sqrt(cs * (2 - cs) * mueff) * invsqrt[i]);
    const psNorm = Math.sqrt(ps.reduce((s, v) => s + v * v, 0));
    const hsig = psNorm / Math.sqrt(1 - (1 - cs) ** (2 * (gen + 1))) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    pc = pc.map((p, i) => (1 - cc) * p + hsig * Math.sqrt(cc * (2 - cc) * mueff) * step[i]);
    const artmp = pop.slice(0, mu).map((p) => p.y.map((v, i) => (v - old[i]) / sigma));
    C = C.map((row, i) => row.map((cij, j) =>
      (1 - c1 - cmu) * cij
      + c1 * (pc[i] * pc[j] + (1 - hsig) * cc * (2 - cc) * cij)
      + cmu * artmp.reduce((s, a, k) => s + w[k] * a[i] * a[j], 0)));
    sigma *= Math.exp((cs / damps) * (psNorm / chiN - 1));
    ({ B, D } = eigen(C));
    gen++;
    if (sigma * Math.max(...D) < 1e-9) break;
  }
  return { ...best, evals };
}

/** Eigen-decomposition of a small symmetric matrix (Jacobi); returns B (columns = vectors) and sqrt eigenvalues D. */
function eigen(A: number[][]): { B: number[][]; D: number[] } {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { B: V, D: a.map((r, i) => Math.sqrt(Math.max(r[i], 1e-20))) };
}

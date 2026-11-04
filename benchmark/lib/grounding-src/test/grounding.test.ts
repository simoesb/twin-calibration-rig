import * as THREE from "three";
import { cmaes } from "../cmaes";
import { computeDeviation, deviationByCoverage } from "../deviation";
import { computeCoverage } from "../coverage";
import { longestDimension } from "../registration";
import { groundWithVerification } from "../policy";

const box = (w: number, h: number, d: number, pos: [number, number, number] = [0, 0, 0]) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, 8, 8, 8), new THREE.MeshStandardMaterial());
  m.position.set(...pos);
  m.updateMatrixWorld(true);
  return m;
};
const camera = (pos: [number, number, number], look: [number, number, number] = [0, 0, 0]) => {
  const c = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  c.position.set(...pos);
  c.lookAt(...look);
  c.updateMatrixWorld(true);
  return c;
};

describe("cmaes", () => {
  it("minimises a shifted, badly scaled quadratic", async () => {
    const target = [3, -2, 0.5, 10];
    const f = (x: number[]) => x.reduce((s, v, i) => s + (i + 1) ** 3 * (v - target[i]) ** 2, 0);
    const r = await cmaes(f, [0, 0, 0, 0], { sigma: 2, maxEvals: 3000, seed: 3 });
    r.x.forEach((v, i) => expect(v).toBeCloseTo(target[i], 2));
  });
});

describe("deviation", () => {
  it("measures a uniform offset between two boxes", () => {
    const ref = box(1, 1, 1);
    const grown = box(1.2, 1.2, 1.2); // every face 0.1 outside the reference
    const r = computeDeviation(grown, ref, 4000);
    expect(r.forward.mean).toBeCloseTo(0.1, 2);
    // Corners are 0.1·√3 from the reference corners.
    expect(r.forward.max).toBeCloseTo(0.1 * Math.sqrt(3), 1);
    // Signed: the grown box lies outside the reference.
    const values = [...r.perMesh.values()][0];
    expect(values.every((v) => v > 0)).toBe(true);
  });
  it("is zero for identical geometry", () => {
    const r = computeDeviation(box(1, 1, 1), box(1, 1, 1), 2000);
    expect(r.chamfer).toBeLessThan(1e-6);
  });
});

describe("longestDimension", () => {
  it("does not change when the model is turned about the vertical", () => {
    for (const yawDeg of [0, 30, 45, 80]) {
      const m = box(0.12, 0.05, 0.08);
      m.rotation.y = THREE.MathUtils.degToRad(yawDeg);
      m.updateMatrixWorld(true);
      expect(longestDimension(m)).toBeCloseTo(0.12, 6);
    }
  });
  it("takes the height when the model is tallest", () => {
    expect(longestDimension(box(0.05, 0.2, 0.08))).toBeCloseTo(0.2, 6);
  });
});

describe("coverage", () => {
  it("sees the faces turned toward the camera and infers the rest", () => {
    // A camera on the +z axis sees only the +z face of a cube (1/6 of its area).
    const r = computeCoverage(box(1, 1, 1), [camera([0, 0, 5])], { samples: 6000 });
    expect(r.fraction).toBeGreaterThan(0.14);
    expect(r.fraction).toBeLessThan(0.19);
  });
  it("adds what a second camera sees", () => {
    const r = computeCoverage(box(1, 1, 1), [camera([0, 0, 5]), camera([5, 0, 0])], { samples: 6000 });
    expect(r.fraction).toBeGreaterThan(0.30);
    expect(r.fraction).toBeLessThan(0.36);
  });
  it("respects occluders", () => {
    const wall = box(3, 3, 0.1, [0, 0, 2]);
    const r = computeCoverage(box(1, 1, 1), [camera([0, 0, 5])], { samples: 3000, occluders: [wall] });
    expect(r.fraction).toBeLessThan(0.01);
  });
  it("does not see the back face of a thin wall", () => {
    // A 6 mm plate facing the camera: only its front face (≈ half the area) is seen.
    const r = computeCoverage(box(0.12, 0.08, 0.006), [camera([0, 0, 0.6])], { samples: 6000 });
    expect(r.fraction).toBeGreaterThan(0.40);
    expect(r.fraction).toBeLessThan(0.50);
  });
  it("does not depend on unrelated geometry far away", () => {
    const plate = () => box(0.12, 0.08, 0.006);
    const alone = computeCoverage(plate(), [camera([0, 0, 0.6])], { samples: 4000 });
    const far = box(0.01, 0.01, 0.01, [10, 0, -10]);
    const withFar = computeCoverage(plate(), [camera([0, 0, 0.6])], { samples: 4000, occluders: [far] });
    expect(withFar.fraction).toBeCloseTo(alone.fraction, 6);
  });
  it("splits deviation into observed and inferred surface", () => {
    // Model = reference except its back half is pushed out: error only where the camera cannot see.
    const ref = box(1, 1, 1);
    const model = box(1, 1, 1.4, [0, 0, -0.2]);
    const split = deviationByCoverage(model, ref, [camera([0, 0, 5])], { samples: 6000 });
    expect(split.observed.mean).toBeLessThan(0.01);
    expect(split.inferred.mean).toBeGreaterThan(0.1);
  });
});

describe("policy", () => {
  const views = [{ name: "inspection", maskPixels: 900 }, { name: "side", maskPixels: 1200 }, { name: "cell", maskPixels: 300 }];
  it("accepts the first candidate that verifies", async () => {
    const r = await groundWithVerification(views, async (v) => ({ agreement: v.name === "inspection" ? 0.95 : 0.5, heightRatio: 1.02, longestRatio: 0.98 }), { first: "inspection" });
    expect(r.chosen?.view).toBe("inspection");
    expect(r.generations).toBe(1);
    expect(r.unverified).toBe(false);
  });
  it("regenerates from the largest remaining view when agreement is low", async () => {
    const r = await groundWithVerification(views, async (v) => ({ agreement: v.name === "side" ? 0.93 : 0.8 }), { first: "inspection" });
    expect(r.decisions.map((d) => d.view)).toEqual(["inspection", "side"]);
    expect(r.chosen?.view).toBe("side");
  });
  it("rejects declared-dimension conflicts and returns the best unverified candidate when the budget ends", async () => {
    const r = await groundWithVerification(views, async (v) => ({ agreement: v.name === "cell" ? 0.97 : 0.92, heightRatio: 1.25 }), { first: "inspection" });
    expect(r.unverified).toBe(true);
    expect(r.generations).toBe(3);
    expect(r.chosen?.view).toBe("cell");
    expect(r.decisions.every((d) => !d.verified)).toBe(true);
  });
});

// Procedural PBR assets for the demo twin, exported as GLB.
//
//   node build-assets.mjs            — writes out/democell.glb, out/bracket-draft.glb, out/assets.json
//
// democell.glb — the cell the DemoCell twin's Models3D points at. Node names are the
//   contract with the twin: `root/Floor`, `root/ConveyorBed`, `root/Carrier` (driven
//   live by the conveyor's Operation.Position through the SceneMapping) and
//   `root/Station` (robot on its pedestal, inspection bench, fencing). Metres, Y up; the belt top is at y = 0.40, the carrier rests on
//   it at x = -0.8 (travel 0 → 1.6 m along +x). The handled parts are machined
//   brackets at their declared size (W 0.12, H 0.08, D 0.05 m).
// bracket-draft.glb — what an image-to-3D service returns for the Bracket: the same
//   L-bracket normalised to ~1 unit wide (so it must be scaled from the Bracket's
//   declared dimensions), slightly off in its height ratio and with a scanned,
//   faceted surface. Origin at the bottom centre.
// bracket-reference.glb — the machined bracket at its declared size (the benchmark's ground truth).
// assets.json — measured bounding boxes, used to seed evidence that matches the geometry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';

// GLTFExporter reads Blobs through FileReader, which Node lacks.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((r) => { this.result = r; this.onload?.({ target: this }); this.onloadend?.({ target: this }); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((r) => { this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(r).toString('base64')}`; this.onload?.({ target: this }); this.onloadend?.({ target: this }); }); }
};

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });

// ── Materials ───────────────────────────────────────────────────────────────
const std = (name, color, metalness, roughness, extra = {}) =>
  Object.assign(new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra }), { name });
const M = {
  alu:       std('Aluminium',        '#c5cad0', 0.9,  0.32),
  aluDark:   std('AluminiumDark',    '#8b929a', 0.85, 0.42),
  machined:  std('MachinedSteel',    '#b9c0c8', 0.95, 0.24),
  slot:      std('ExtrusionSlot',    '#4d535b', 0.6,  0.6),
  steel:     std('Steel',            '#9ea5ad', 0.95, 0.28),
  painted:   std('PaintedSteel',     '#3a4653', 0.25, 0.55),
  motor:     std('MotorBlue',        '#3f5f7f', 0.35, 0.45),
  rubber:    std('BeltRubber',       '#1f2227', 0.0,  0.88),
  ridge:     std('BeltRidge',        '#2a2e34', 0.0,  0.8),
  floor:     std('EpoxyFloor',       '#c3c8cd', 0.0,  0.62),
  floorZone: std('EpoxyZone',        '#a7aeb5', 0.0,  0.66),
  yellow:    std('SafetyYellow',     '#f2c230', 0.05, 0.55),
  black:     std('SafetyBlack',      '#202226', 0.05, 0.6),
  anodBlue:  std('AnodisedBlue',     '#2f6fd1', 0.55, 0.32),
  nylon:     std('FixtureOrange',    '#f08a24', 0.0,  0.5),
  robot:     std('RobotOrange',      '#f07f1a', 0.15, 0.38),
  robotDark: std('RobotJoint',       '#2c2f34', 0.4,  0.42),
  robotCap:  std('RobotCap',         '#5a6068', 0.6,  0.35),
  laminate:  std('TableLaminate',    '#e3e6ea', 0.05, 0.45),
  edge:      std('TableEdge',        '#30353b', 0.1,  0.5),
  cabinet:   std('CabinetWhite',     '#eceef1', 0.1,  0.48),
  drawer:    std('DrawerFront',      '#dfe3e8', 0.1,  0.45),
  tray:      std('TrayBlue',         '#2c5aa0', 0.0,  0.55),
  granite:   std('Granite',          '#2b2e33', 0.0,  0.3),
  screen:    std('HmiScreen',        '#0c1622', 0.2,  0.25, { emissive: '#2b7de9', emissiveIntensity: 0.55 }),
  green:     std('StackGreen',       '#1fbf5a', 0.0,  0.3,  { emissive: '#22c55e', emissiveIntensity: 2.2 }),
  amber:     std('StackAmber',       '#8a5a10', 0.0,  0.35, { transparent: true, opacity: 0.85 }),
  red:       std('StackRed',         '#7a1d1d', 0.0,  0.35, { transparent: true, opacity: 0.85 }),
  mesh:      std('FenceMesh',        '#3b3f45', 0.6,  0.5),
  button:    std('ButtonGreen',      '#1e9e4a', 0.0,  0.4,  { emissive: '#16a34a', emissiveIntensity: 0.6 }),
  estop:     std('EStopRed',         '#d32020', 0.0,  0.4),
  cable:     std('Cable',            '#18191c', 0.0,  0.7),
};

// ── Builders ────────────────────────────────────────────────────────────────
const mesh = (geo, mat, name, [x, y, z] = [0, 0, 0], [rx, ry, rz] = [0, 0, 0]) => {
  const m = new THREE.Mesh(geo, mat);
  m.name = name; m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
  return m;
};
/** Rounded box; `r` defaults to a fraction of the smallest side. */
const rboxGeo = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 3, r ?? Math.min(w, h, d) * 0.18);
const rbox = (w, h, d, mat, name, pos, rot, r) => mesh(rboxGeo(w, h, d, r), mat, name, pos, rot);
const box = (w, h, d, mat, name, pos, rot) => mesh(new THREE.BoxGeometry(w, h, d), mat, name, pos, rot);
/** Cylinder along `axis` ('x' | 'y' | 'z'). */
const cylGeo = (r, len, axis = 'y', seg = 32, r2 = r) => {
  const g = new THREE.CylinderGeometry(r2, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
};
const cyl = (r, len, mat, name, pos, axis = 'y', seg = 32) => mesh(cylGeo(r, len, axis, seg), mat, name, pos);
const lathe = (profile, mat, name, pos, seg = 48) => mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg), mat, name, pos);
const group = (name, [x, y, z] = [0, 0, 0], children = []) => {
  const g = new THREE.Group(); g.name = name; g.position.set(x, y, z);
  children.forEach((c) => g.add(c));
  return g;
};
/** One mesh from many (rounded) box placements — keeps node counts low for grids, slats and stripes. */
const boxes = (items, mat, name, rounded = false) => {
  const geos = items.map(([w, h, d, x, y, z, ry = 0]) => {
    const g = rounded ? rboxGeo(w, h, d) : new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    return g.translate(x, y, z);
  });
  return mesh(mergeGeometries(geos), mat, name);
};
/** Aluminium extrusion (rounded profile with a dark slot on two faces), along `axis`. */
const extrusion = (len, s, axis, name, [x, y, z]) => {
  const g = group(name, [x, y, z]);
  const dims = axis === 'x' ? [len, s, s] : axis === 'y' ? [s, len, s] : [s, s, len];
  g.add(rbox(...dims, M.alu, `${name}_Profile`, [0, 0, 0], [0, 0, 0], s * 0.12));
  const slotW = s * 0.22, depth = 0.0015;
  const faces = axis === 'y'
    ? [[slotW, len * 0.98, depth, 0, 0, s / 2], [slotW, len * 0.98, depth, 0, 0, -s / 2], [depth, len * 0.98, slotW, s / 2, 0, 0], [depth, len * 0.98, slotW, -s / 2, 0, 0]]
    : axis === 'x'
      ? [[len * 0.98, slotW, depth, 0, 0, s / 2], [len * 0.98, slotW, depth, 0, 0, -s / 2], [len * 0.98, depth, slotW, 0, s / 2, 0]]
      : [[slotW, depth, len * 0.98, 0, s / 2, 0], [depth, slotW, len * 0.98, s / 2, 0, 0], [depth, slotW, len * 0.98, -s / 2, 0, 0]];
  g.add(boxes(faces, M.slot, `${name}_Slots`));
  return g;
};

// ── Bracket geometry (shared by the machined parts and the reconstruction) ──
/**
 * L-bracket: base plate (W × D × T) with two holes `spacing` apart, a back flange
 * of height H with an oval slot, and two gussets. Origin at the bottom centre.
 */
function bracketGeometry({ W, D, T, H, R, spacing, bevel }) {
  const bv = { bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 36 };
  const plate = new THREE.Shape();
  plate.moveTo(-W / 2, -D / 2); plate.lineTo(W / 2, -D / 2); plate.lineTo(W / 2, D / 2); plate.lineTo(-W / 2, D / 2); plate.lineTo(-W / 2, -D / 2);
  for (const x of [-spacing / 2, spacing / 2]) {
    const h = new THREE.Path(); h.absarc(x, T / 2, R, 0, Math.PI * 2, true); plate.holes.push(h);
  }
  // Shape y → world z, extrusion → world y (down), then lifted so y ∈ [0, T].
  const base = new THREE.ExtrudeGeometry(plate, { depth: T - 2 * bevel, ...bv }).rotateX(Math.PI / 2).translate(0, T - bevel, 0);
  const flangeShape = new THREE.Shape();
  flangeShape.moveTo(-W / 2, 0); flangeShape.lineTo(W / 2, 0); flangeShape.lineTo(W / 2, H - 2 * bevel); flangeShape.lineTo(-W / 2, H - 2 * bevel); flangeShape.lineTo(-W / 2, 0);
  const slot = new THREE.Path(); slot.absellipse(0, H * 0.6, W * 0.16, H * 0.07, 0, Math.PI * 2, true); flangeShape.holes.push(slot);
  const flange = new THREE.ExtrudeGeometry(flangeShape, { depth: T - 2 * bevel, ...bv }).translate(0, bevel, -D / 2 + bevel);
  const gShape = new THREE.Shape();
  const gz = (D - T) * 0.55, gy = H * 0.5;
  gShape.moveTo(0, 0); gShape.lineTo(gz, 0); gShape.lineTo(0, gy); gShape.lineTo(0, 0);
  const gt = W * 0.04;
  const gussets = [-1, 1].map((s) =>
    new THREE.ExtrudeGeometry(gShape, { depth: gt, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(s * W * 0.4 + gt / 2, T, -D / 2 + T));
  return mergeGeometries([base, flange, ...gussets]);
}
/** A machined bracket at its declared size. */
const machinedBracket = (name, pos, ry = 0) =>
  mesh(bracketGeometry({ W: 0.12, D: 0.05, T: 0.006, H: 0.08, R: 0.0035, spacing: 0.06, bevel: 0.0008 }), M.machined, name, pos, [0, ry, 0]);

// ── DemoCell ────────────────────────────────────────────────────────────────
function floor() {
  const g = group('Floor');
  g.add(box(3.8, 0.02, 2.6, M.floor, 'Floor_Slab', [0.2, -0.01, 0]));
  g.add(box(1.25, 0.002, 1.3, M.floorZone, 'Floor_StationZone', [1.42, 0.001, 0]));
  g.add(boxes([[3.4, 0.002, 0.05, 0.1, 0.002, 0.82], [3.4, 0.002, 0.05, 0.1, 0.002, -0.82]], M.yellow, 'Floor_WalkwayLines'));
  const yellow = [], black = [];
  const dash = 0.08;
  const edge = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.floor(len / dash), ang = Math.atan2(z1 - z0, x1 - x0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      (i % 2 ? black : yellow).push([dash, 0.003, 0.05, x0 + (x1 - x0) * t, 0.0025, z0 + (z1 - z0) * t, -ang]);
    }
  };
  edge(0.82, -0.62, 2.04, -0.62); edge(2.04, -0.62, 2.04, 0.62); edge(2.04, 0.62, 0.82, 0.62); edge(0.82, 0.62, 0.82, -0.62);
  g.add(boxes(yellow, M.yellow, 'Floor_HazardYellow'));
  g.add(boxes(black, M.black, 'Floor_HazardBlack'));
  return g;
}

// ── Cell layout (world, metres) ─────────────────────────────────────────────
// Flow: 1 parts arrive on carriers → 2 the carrier stops at the head-end stop
// (carrier at x = 0.8) → 3 the robot picks the bracket and puts it on the
// granite plate for inspection → 4 inspected parts go to the output tray.
const PICK = [0.8, 0.49, -0.022];               // flange top of the part in the stopped carrier
const ROBOT_BASE = [1.05, 0.42, -0.38];         // robot flange on top of its pedestal
const ROBOT_SCALE = 1.45;                       // ~0.85 m reach
const BENCH = [1.48, 0, 0.18];

function conveyor() {
  const g = group('ConveyorBed');
  for (const z of [-0.225, 0.225]) g.add(extrusion(2.04, 0.06, 'x', `Conveyor_Frame${z < 0 ? 'L' : 'R'}`, [0, 0.355, z]));
  for (const x of [-0.9, 0, 0.9]) {
    for (const z of [-0.2, 0.2]) {
      g.add(extrusion(0.29, 0.045, 'y', `Conveyor_Leg${x}${z < 0 ? 'L' : 'R'}`, [x, 0.17, z]));
      g.add(lathe([[0, 0], [0.034, 0], [0.036, 0.006], [0.03, 0.012], [0.008, 0.014], [0.008, 0.03], [0, 0.03]], M.black, `Conveyor_Foot${x}${z < 0 ? 'L' : 'R'}`, [x, 0, z], 24));
    }
    g.add(extrusion(0.36, 0.03, 'z', `Conveyor_Brace${x}`, [x, 0.08, 0]));
  }
  for (const z of [-0.2, 0.2]) g.add(extrusion(1.75, 0.03, 'x', `Conveyor_Stringer${z < 0 ? 'L' : 'R'}`, [0, 0.08, z]));
  g.add(rbox(1.94, 0.012, 0.40, M.rubber, 'Conveyor_Belt', [0, 0.394, 0], [0, 0, 0], 0.004));
  const ridges = [];
  for (let x = -0.95; x <= 0.95; x += 0.05) ridges.push([0.006, 0.003, 0.39, x, 0.4015, 0]);
  g.add(boxes(ridges, M.ridge, 'Conveyor_BeltRidges'));
  for (const x of [-0.985, 0.985]) {
    g.add(cyl(0.042, 0.41, M.alu, `Conveyor_Roller${x < 0 ? 'Tail' : 'Head'}`, [x, 0.352, 0], 'z'));
    for (const z of [-0.245, 0.245]) g.add(cyl(0.03, 0.012, M.aluDark, `Conveyor_RollerCap${x < 0 ? 'T' : 'H'}${z < 0 ? 'L' : 'R'}`, [x, 0.352, z], 'z'));
  }
  for (const z of [-0.205, 0.205]) {
    g.add(cyl(0.008, 1.9, M.steel, `Conveyor_Guide${z < 0 ? 'L' : 'R'}`, [0, 0.445, z], 'x', 16));
    const posts = [];
    for (const x of [-0.85, -0.42, 0, 0.42, 0.85]) posts.push([0.012, 0.06, 0.012, x, 0.415, z + Math.sign(z) * 0.012]);
    g.add(boxes(posts, M.aluDark, `Conveyor_GuidePosts${z < 0 ? 'L' : 'R'}`, true));
  }
  // Pick position: end stop across the lane and a part-present sensor with reflector.
  g.add(boxes([[0.03, 0.06, 0.02, 0.955, 0.415, -0.185], [0.03, 0.06, 0.02, 0.955, 0.415, 0.185]], M.aluDark, 'Conveyor_EndStopPosts', true));
  g.add(rbox(0.03, 0.03, 0.35, M.nylon, 'Conveyor_EndStop', [0.955, 0.43, 0], [0, 0, 0], 0.006));
  g.add(rbox(0.032, 0.022, 0.026, M.painted, 'Conveyor_PartSensor', [0.8, 0.475, 0.215], [0, 0, 0], 0.004));
  g.add(cyl(0.004, 0.004, M.button, 'Conveyor_PartSensorLed', [0.8, 0.488, 0.215]));
  g.add(rbox(0.03, 0.022, 0.006, M.estop, 'Conveyor_Reflector', [0.8, 0.475, -0.214], [0, 0, 0], 0.002));
  // Drive at the tail end, clear of the robot.
  g.add(cyl(0.06, 0.16, M.motor, 'Conveyor_Motor', [-0.985, 0.33, 0.36], 'z'));
  g.add(rbox(0.11, 0.11, 0.08, M.motor, 'Conveyor_Gearbox', [-0.985, 0.34, 0.27]));
  const fins = [];
  for (let i = 0; i < 7; i++) fins.push([0.13, 0.004, 0.14, -0.985, 0.30 + i * 0.01, 0.36]);
  g.add(boxes(fins, M.motor, 'Conveyor_MotorFins'));
  g.add(cyl(0.062, 0.01, M.aluDark, 'Conveyor_MotorCap', [-0.985, 0.33, 0.445], 'z'));
  g.add(rbox(0.14, 0.12, 0.07, M.painted, 'Conveyor_ControlBox', [-0.75, 0.24, -0.29]));
  g.add(cyl(0.012, 0.015, M.button, 'Conveyor_StartButton', [-0.78, 0.25, -0.328], 'z'));
  g.add(cyl(0.018, 0.02, M.estop, 'Conveyor_EStop', [-0.72, 0.25, -0.33], 'z'));
  return g;
}

function carrier() {
  // Origin on the belt surface; the live binding offsets it along +x (0 → 1.6 m to the stop).
  const g = group('Carrier', [-0.8, 0.40, 0]);
  g.add(rbox(0.26, 0.022, 0.30, M.anodBlue, 'Carrier_Pallet', [0, 0.011, 0], [0, 0, 0], 0.004));
  g.add(boxes([[0.26, 0.006, 0.02, 0, 0.003, -0.14], [0.26, 0.006, 0.02, 0, 0.003, 0.14]], M.black, 'Carrier_WearStrips'));
  for (const [x, z] of [[-0.11, -0.125], [0.11, 0.125]]) {
    g.add(lathe([[0, 0], [0.01, 0], [0.01, 0.022], [0.007, 0.028], [0, 0.03]], M.steel, `Carrier_Pin${x < 0 ? 'A' : 'B'}`, [x, 0.022, z], 20));
  }
  // Nest: a stop behind the flange and two side guides, sized to the bracket.
  g.add(rbox(0.15, 0.03, 0.016, M.nylon, 'Carrier_NestStop', [0, 0.037, -0.042], [0, 0, 0], 0.003));
  g.add(boxes([[0.014, 0.018, 0.07, -0.072, 0.031, -0.002], [0.014, 0.018, 0.07, 0.072, 0.031, -0.002]], M.nylon, 'Carrier_NestGuides', true));
  for (const x of [-0.05, 0.05]) g.add(cyl(0.004, 0.006, M.black, `Carrier_NestScrew${x < 0 ? 'A' : 'B'}`, [x, 0.053, -0.042]));
  g.add(machinedBracket('Carrier_Part', [0, 0.022, 0]));
  g.add(rbox(0.03, 0.012, 0.004, M.black, 'Carrier_RfidTag', [0, 0.012, 0.152], [0, 0, 0], 0.001));
  return g;
}

/** "Bone" link: a stadium extruded in Z, from radius r1 at y = 0 to r2 at y = len. */
const boneGeo = (r1, r2, len, depth) => {
  const s = new THREE.Shape();
  s.moveTo(r1, 0); s.lineTo(r2, len); s.absarc(0, len, r2, 0, Math.PI, false); s.lineTo(-r1, 0); s.absarc(0, 0, r1, Math.PI, Math.PI * 2, false);
  return new THREE.ExtrudeGeometry(s, { depth: depth - 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 3, curveSegments: 32 }).translate(0, 0, -(depth - 0.012) / 2);
};
/** Joint housing along Z: an orange drum between two dark rings, with grey caps. */
const joint = (name, r, w, pos) => group(name, pos, [
  cyl(r, w * 0.76, M.robot, `${name}_Drum`, [0, 0, 0], 'z', 40),
  cyl(r * 1.02, w * 0.12, M.robotDark, `${name}_RingA`, [0, 0, w * 0.44], 'z', 40),
  cyl(r * 1.02, w * 0.12, M.robotDark, `${name}_RingB`, [0, 0, -w * 0.44], 'z', 40),
  cyl(r * 0.7, w * 1.08, M.robotCap, `${name}_Caps`, [0, 0, 0], 'z', 32),
]);

/**
 * Six-axis arm (unit-scale geometry, placed at `base` and scaled by `k`) posed so
 * its fingertips grip `target` with the gripper vertical: the base yaws toward the
 * target, shoulder + elbow solve the two-link reach to the wrist, the wrist keeps
 * the tool pointing down.
 */
function robotArm(base, target, k) {
  const H_SHOULDER = 0.17, L1 = 0.34, L2 = 0.24, L_TOOL = 0.115;
  const t = target.map((v, i) => (v - base[i]) / k);
  const yaw = Math.atan2(t[2], -t[0]);
  const h = Math.hypot(t[0], t[2]), v = t[1] + L_TOOL - H_SHOULDER, D = Math.hypot(h, v);
  if (D > L1 + L2) throw new Error(`robot target out of reach (${(D * k).toFixed(3)} m > ${((L1 + L2) * k).toFixed(3)} m)`);
  // Link angles are measured from vertical toward the target (rotation about Z).
  const shoulder = Math.atan2(h, v) - Math.acos((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D));      // elbow up
  const elbow = Math.PI - Math.acos((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2));
  const wrist = Math.PI - (shoulder + elbow);

  const arm = group('Station_Robot', base);
  arm.scale.setScalar(k);
  arm.add(lathe([[0, 0], [0.095, 0], [0.095, 0.012], [0.085, 0.018], [0.075, 0.03], [0.072, 0.055], [0, 0.055]], M.robotDark, 'Robot_Base'));
  const bolts = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; bolts.push(cylGeo(0.006, 0.006).translate(Math.cos(a) * 0.085, 0.015, Math.sin(a) * 0.085)); }
  arm.add(mesh(mergeGeometries(bolts), M.steel, 'Robot_BaseBolts'));

  const turret = group('Robot_Turret', [0, 0.055, 0]);
  turret.rotation.y = yaw;
  arm.add(turret);
  turret.add(lathe([[0, 0], [0.07, 0], [0.072, 0.01], [0.068, 0.07], [0.055, 0.1], [0, 0.1]], M.robot, 'Robot_Column'));
  turret.add(cyl(0.035, 0.09, M.robotCap, 'Robot_J1Motor', [0.055, 0.05, -0.04], 'y'));
  turret.add(joint('Robot_J2', 0.058, 0.14, [0, H_SHOULDER - 0.055, 0]));

  const upper = group('Robot_UpperArm', [0, H_SHOULDER - 0.055, 0]);
  upper.rotation.z = shoulder;
  turret.add(upper);
  upper.add(mesh(boneGeo(0.052, 0.04, L1, 0.075), M.robot, 'Robot_UpperLink'));
  upper.add(cyl(0.03, 0.08, M.robotCap, 'Robot_J2Motor', [0, 0.02, -0.075], 'z'));
  const curve = new THREE.CatmullRomCurve3([[0.05, -0.02, -0.05], [0.07, 0.12, -0.055], [0.06, 0.26, -0.05], [0.03, 0.36, -0.04]].map((p) => new THREE.Vector3(...p)));
  upper.add(mesh(new THREE.TubeGeometry(curve, 48, 0.008, 10), M.cable, 'Robot_Cable'));

  const fore = group('Robot_Forearm', [0, L1, 0]);
  fore.rotation.z = elbow;
  upper.add(fore);
  fore.add(joint('Robot_J3', 0.045, 0.11, [0, 0, 0]));
  fore.add(rbox(0.07, 0.055, 0.07, M.robot, 'Robot_J4Housing', [0, -0.05, 0], [0, 0, 0], 0.016));
  fore.add(cyl(0.026, 0.012, M.robotCap, 'Robot_J4Cap', [0, -0.081, 0]));
  fore.add(mesh(cylGeo(0.036, 0.19, 'y', 36, 0.028), M.robot, 'Robot_ForeLink', [0, 0.105, 0]));
  fore.add(rbox(0.06, 0.05, 0.065, M.robot, 'Robot_WristHousing', [0, L2 - 0.02, 0], [0, 0, 0], 0.015));
  fore.add(joint('Robot_J5', 0.026, 0.075, [0, L2, 0]));

  const hand = group('Robot_Wrist', [0, L2, 0]);
  hand.rotation.z = wrist;
  fore.add(hand);
  hand.add(cyl(0.022, 0.03, M.robotDark, 'Robot_J6', [0, 0.032, 0]));
  hand.add(cyl(0.026, 0.008, M.aluDark, 'Robot_Flange', [0, 0.051, 0]));
  hand.add(rbox(0.07, 0.03, 0.04, M.robotDark, 'Robot_GripperBody', [0, 0.07, 0], [0, 0, 0], 0.006));
  // Fingers closed on the part's flange.
  hand.add(boxes([[0.01, 0.045, 0.026, -0.0095, 0.105, 0], [0.01, 0.045, 0.026, 0.0095, 0.105, 0]], M.aluDark, 'Robot_Fingers', true));
  hand.add(boxes([[0.003, 0.02, 0.022, -0.0035, 0.115, 0], [0.003, 0.02, 0.022, 0.0035, 0.115, 0]], M.black, 'Robot_FingerPads', true));
  return arm;
}

/** Robot pedestal with anchor plate, and the robot controller cabinet beside it. */
function robotCell() {
  const [bx, by, bz] = ROBOT_BASE;
  const g = group('Station_RobotCell');
  g.add(rbox(0.32, 0.02, 0.32, M.painted, 'Pedestal_FootPlate', [bx, 0.01, bz], [0, 0, 0], 0.004));
  g.add(rbox(0.18, by - 0.04, 0.18, M.robotDark, 'Pedestal_Column', [bx, (by - 0.04) / 2 + 0.02, bz], [0, 0, 0], 0.01));
  g.add(rbox(0.26, 0.02, 0.26, M.aluDark, 'Pedestal_TopPlate', [bx, by - 0.01, bz], [0, 0, 0], 0.004));
  const anchors = [];
  for (const [dx, dz] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]]) anchors.push(cylGeo(0.008, 0.014).translate(bx + dx, 0.027, bz + dz));
  g.add(mesh(mergeGeometries(anchors), M.steel, 'Pedestal_Anchors'));
  g.add(robotArm(ROBOT_BASE, PICK, ROBOT_SCALE));
  // Controller cabinet with vents and a status light.
  g.add(rbox(0.3, 0.5, 0.2, M.painted, 'Controller_Cabinet', [1.4, 0.26, -0.56], [0, 0, 0], 0.01));
  const vents = [];
  for (let i = 0; i < 6; i++) vents.push([0.18, 0.006, 0.004, 1.4, 0.12 + i * 0.022, -0.459]);
  g.add(boxes(vents, M.black, 'Controller_Vents'));
  g.add(cyl(0.01, 0.006, M.green, 'Controller_Status', [1.5, 0.45, -0.458], 'z', 16));
  return g;
}

function bench() {
  const g = group('Station_Bench', BENCH);
  g.add(rbox(0.72, 0.028, 0.62, M.laminate, 'Bench_Top', [0, 0.786, 0], [0, 0, 0], 0.006));
  g.add(rbox(0.724, 0.014, 0.624, M.edge, 'Bench_EdgeBand', [0, 0.768, 0], [0, 0, 0], 0.005));
  for (const [x, z] of [[-0.33, -0.28], [0.33, -0.28], [-0.33, 0.28], [0.33, 0.28]]) {
    g.add(extrusion(0.72, 0.045, 'y', `Bench_Leg${x < 0 ? 'L' : 'R'}${z < 0 ? 'B' : 'F'}`, [x, 0.4, z]));
    g.add(lathe([[0, 0], [0.032, 0], [0.034, 0.006], [0.028, 0.012], [0.008, 0.014], [0.008, 0.04], [0, 0.04]], M.black, `Bench_Foot${x < 0 ? 'L' : 'R'}${z < 0 ? 'B' : 'F'}`, [x, 0, z], 24));
  }
  g.add(extrusion(0.62, 0.04, 'x', 'Bench_ApronB', [0, 0.735, -0.28]));
  g.add(extrusion(0.62, 0.04, 'x', 'Bench_ApronF', [0, 0.735, 0.28]));
  g.add(extrusion(0.52, 0.04, 'z', 'Bench_ApronL', [-0.33, 0.735, 0]));
  g.add(extrusion(0.52, 0.04, 'z', 'Bench_ApronR', [0.33, 0.735, 0]));
  g.add(extrusion(0.62, 0.035, 'x', 'Bench_LowRailB', [0, 0.16, -0.28]));
  g.add(extrusion(0.62, 0.035, 'x', 'Bench_LowRailF', [0, 0.16, 0.28]));
  g.add(rbox(0.62, 0.016, 0.52, M.painted, 'Bench_Shelf', [0, 0.186, 0], [0, 0, 0], 0.004));
  g.add(rbox(0.36, 0.44, 0.5, M.cabinet, 'Bench_Cabinet', [0.1, 0.49, 0], [0, 0, 0], 0.008));
  const fronts = [], handles = [];
  [[0.635, 0.1], [0.515, 0.12], [0.36, 0.17]].forEach(([y, h]) => {
    fronts.push(rboxGeo(0.34, h - 0.012, 0.012, 0.004).translate(0.1, y, 0.255));
    handles.push(new THREE.CapsuleGeometry(0.006, 0.1, 4, 12).rotateZ(Math.PI / 2).translate(0.1, y + h * 0.18, 0.272));
  });
  g.add(mesh(mergeGeometries(fronts), M.drawer, 'Bench_DrawerFronts'));
  g.add(mesh(mergeGeometries(handles), M.alu, 'Bench_DrawerHandles'));
  // 3 — granite inspection plate within the robot's reach (the bracket draft sits here).
  g.add(rbox(0.28, 0.03, 0.22, M.granite, 'Bench_InspectionPlate', [-0.2, 0.815, -0.17], [0, 0, 0], 0.004));
  // 4 — output tray with inspected brackets.
  const tray = group('Bench_OutputTray', [0.15, 0.8, -0.12]);
  tray.add(boxes([[0.31, 0.006, 0.2, 0, 0.003, 0], [0.31, 0.035, 0.008, 0, 0.0175, -0.096], [0.31, 0.035, 0.008, 0, 0.0175, 0.096], [0.008, 0.035, 0.2, -0.151, 0.0175, 0], [0.008, 0.035, 0.2, 0.151, 0.0175, 0]], M.tray, 'Tray_Body', true));
  [[-0.07, -0.045], [0.07, -0.045], [-0.07, 0.045]].forEach(([x, z], i) => tray.add(machinedBracket(`Tray_Part${i}`, [x, 0.006, z], i % 2 ? 0.04 : -0.03)));
  g.add(tray);
  // Stack light on the right edge, HMI facing the operator at the front right.
  g.add(cyl(0.012, 0.36, M.aluDark, 'Bench_StackPole', [0.33, 0.98, 0.12], 'y', 16));
  g.add(cyl(0.032, 0.05, M.green, 'Bench_StackGreen', [0.33, 1.185, 0.12]));
  g.add(cyl(0.032, 0.05, M.amber, 'Bench_StackAmber', [0.33, 1.237, 0.12]));
  g.add(cyl(0.032, 0.05, M.red, 'Bench_StackRed', [0.33, 1.289, 0.12]));
  g.add(lathe([[0, 0], [0.032, 0], [0.03, 0.012], [0.018, 0.02], [0, 0.022]], M.black, 'Bench_StackCap', [0.33, 1.314, 0.12], 24));
  g.add(cyl(0.01, 0.42, M.aluDark, 'Bench_HmiPost', [0.31, 1.01, 0.28], 'y', 16));
  const hmi = group('Bench_Hmi', [0.31, 1.25, 0.28]);
  hmi.rotation.set(-0.25, -0.5, 0);
  hmi.add(rbox(0.24, 0.16, 0.025, M.painted, 'Hmi_Bezel', [0, 0, 0], [0, 0, 0], 0.008));
  hmi.add(box(0.21, 0.13, 0.002, M.screen, 'Hmi_Screen', [0, 0, 0.0135]));
  g.add(hmi);
  return g;
}

/** Safety fence panel between two floor points (world). */
function fence(name, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0), ang = -Math.atan2(z1 - z0, x1 - x0);
  const bars = [];
  for (let s = -len / 2 + 0.05; s < len / 2; s += 0.05) bars.push([0.004, 1.0, 0.004, s, 0.65, 0]);
  for (let h = 0.17; h <= 1.14; h += 0.05) bars.push([len, 0.004, 0.004, 0, h, 0]);
  const f = group(name, [(x0 + x1) / 2, 0, (z0 + z1) / 2], [
    boxes(bars, M.mesh, `${name}_Mesh`),
    boxes([[len, 0.03, 0.03, 0, 0.15, 0], [len, 0.03, 0.03, 0, 1.15, 0]], M.yellow, `${name}_Rails`, true),
    boxes([[0.05, 1.3, 0.05, -len / 2, 0.65, 0], [0.05, 1.3, 0.05, len / 2, 0.65, 0]], M.yellow, `${name}_Posts`, true),
  ]);
  f.rotation.y = ang;
  return f;
}

function station() {
  return group('Station', [0, 0, 0], [
    robotCell(),
    bench(),
    fence('Station_FenceBack', 0.82, -0.68, 2.08, -0.68),
    fence('Station_FenceSide', 2.08, -0.68, 2.08, 0.55),
  ]);
}

function democell() {
  const root = group('root', [0, 0, 0], [floor(), conveyor(), carrier(), station()]);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

// ── Reconstructed bracket ───────────────────────────────────────────────────
// The machined bracket normalised to W = 1, with the height ratio slightly wrong
// (0.69 vs the declared 0.667) and a scanned surface: smooth low-amplitude
// displacement (a function of position, so coincident vertices move together and
// the mesh stays closed), mottled colour and faceted normals.
function bracketDraft() {
  // Dense, roughly uniform triangles first, so the displacement reads as a scanned surface.
  const geo = new TessellateModifier(0.032, 10).modify(bracketGeometry({ W: 1.0, D: 0.42, T: 0.075, H: 0.69, R: 0.062, spacing: 0.5, bevel: 0.01 }));
  geo.deleteAttribute('uv');
  const p = geo.attributes.position, colors = new Float32Array(p.count * 3);
  const n3 = (x, y, z) => Math.sin(x * 23.1 + y * 7.3) * Math.cos(z * 19.7 - x * 5.1) + 0.5 * Math.sin(y * 41.3 + z * 13.9)
    + 0.25 * Math.sin(x * 97.0 + z * 61.0) * Math.sin(y * 83.0 - x * 29.0);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 0.0045 * n3(x, y, z);
    p.setXYZ(i, x + d * 0.6, y + d, z + d * 0.6);
    const m = 0.5 + 0.5 * n3(x * 2.3, y * 2.3, z * 2.3);
    const dark = Math.max(0, Math.sin(x * 9 + z * 11) * Math.sin(y * 13) - 0.55) * 0.9;
    c.setRGB(0.55 + 0.12 * m - dark * 0.25, 0.58 + 0.12 * m - dark * 0.25, 0.63 + 0.12 * m - dark * 0.2);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const m = mesh(geo, std('ReconstructedSurface', '#ffffff', 0.35, 0.55, { vertexColors: true, flatShading: true }), 'Bracket_Surface');
  m.castShadow = m.receiveShadow = true;
  return group('Bracket', [0, 0, 0], [m]);
}

// ── Export ──────────────────────────────────────────────────────────────────
async function exportGlb(object, file) {
  const scene = new THREE.Scene();
  scene.add(object);
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(glb));
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return { file, bytes: fs.statSync(path.join(OUT, file)).size, size: size.toArray().map((v) => Number(v.toFixed(4))) };
}

const cell = await exportGlb(democell(), 'democell.glb');
const bracket = await exportGlb(bracketDraft(), 'bracket-draft.glb');
const reference = await exportGlb(group('BracketReference', [0, 0, 0], [machinedBracket('Bracket_Reference', [0, 0, 0])]), 'bracket-reference.glb');
fs.writeFileSync(path.join(OUT, 'assets.json'), JSON.stringify({ democell: cell, bracketDraft: bracket, bracketReference: reference }, null, 2));
console.log(JSON.stringify({ democell: cell, bracketDraft: bracket, bracketReference: reference }));

# Evaluation protocol

This protocol evaluates how well a live digital twin can ground and check 3D geometry produced by an image-to-3D generator. It covers four questions:

1. Does twin-constrained registration place generated meshes metrically, beyond the part it was developed on?
2. Does a size declared in the asset record help?
3. Does regenerating from another twin camera, when the twin's own checks fail, reduce placement failures, and at what cost?
4. Are features the generating camera could not see recovered less often?

It is written so that other generators, parts and camera layouts can be evaluated the same way. Commands are in [Running the evaluation](#10-running-the-evaluation); the results this repository reproduces are in [Reference results](#11-reference-results).

## 1. Hypotheses

| | Hypothesis | Analysis | Specified |
|---|---|---|---|
| H1 | In the standard condition, registration with the declared size (arm B) places every test part with a median centre error ≤ 10 mm, and lower than the naive drop. | Per-part medians; paired B vs naive. | Before testing |
| H2 | The declared size lowers size error (B vs A). | Paired differences, all conditions. | Before testing |
| H3 | Evidence-driven regeneration (C) fails less often than B, most of all under occlusion and a limited view. | Paired failures B vs C; generations per trial. | Before testing |
| H4 | Features the generating camera did not observe are recovered less often than observed features. | Recovery rates by visibility. | Before testing |
| H5 | Occlusion, a limited view and a reflective finish increase failures. | Failures per condition (descriptive). | Before testing |
| E1 | A single generation from the view with the largest mask, or from the side camera, is a cheaper alternative to C. | Failures and generations beside C and D. | After testing |
| E2 | A camera not used for fitting flags failed placements. | Held-out-camera IoU against placement failure. | After testing |

All analyses are reported whatever their outcome. They are exploratory: four designs, ten poses each, no correction for multiple comparisons. Intervals are conditional on the four designs and do not generalise to industrial parts at large.

**Specification status.** So that readers can tell planned from later choices:

- *Fixed before any test reconstruction was evaluated:* H1–H5, parts, poses, conditions, cameras, generator settings, arms A–D, τ and the dimension tolerance, metrics, the feature test, and 68 metric-validation checks. The record of this protocol (SHA-256 `45f9fada9497280589f979997aa926e971e7328fed39604e914c1d66024340b3`) is available from the author.
- *Set after that, before any result of arms C or D existed:* bounding boxes computed from vertices instead of three.js's default box (failures under the default box, which the fixed protocol used: B 79/160, C 18/160, §11); the two rotated-frame validation checks (84 in total); a generation budget of 2 instead of 3, for lack of GPU time.
- *Added after testing:* E1, E2, the feature outcomes of verified candidates, and the pose-block intervals, which replace the pooled tests specified before testing (§9).

## 2. Test and development sets

- **Development:** an L-bracket (nominal 120 × 80 × 50 mm, two Ø7 mm mounting holes, an oval slot), 20 random poses on the inspection plate (`benchmark/`). Every threshold was chosen on it; the generation budget was set by available GPU time.
- **Test:** four parts of different families in `parts/`: a machined fixture block, a turned flange adapter, a cast bearing housing and a folded sheet-metal mount. They are exact CAD solids, reviewed against common design rules before use, and were not used to choose any setting. The authors designed them knowing the method.
- **Declared sizes** of the test parts are taken from the CAD (synthetic asset metadata), not independently measured. The bracket's sensitivity study (`bench.html?stage=sensitivity`) covers wrong declarations.

## 3. Observations

`partbench.html?stage=observe&n=10` renders, per part, 10 poses on the inspection plate. Poses are seeded (FNV-1a of the part id XOR 20261006): uniform yaw, offsets of ±30 mm (x) and ±20 mm (z) from the plate centre, part resting on its base.

- **Cameras** (pose and intrinsics known to the twin, stored per view in `observations.json`):
  - `inspection`: 0.6 m from the plate, 45° elevation, 35° vertical field of view, 1024²;
  - `side`: 0.6 m, from +x, 35°, 1024²;
  - `cell`: the fence camera (called "fence" in the paper), 40°, 1024 × 768.
- **Lighting:** HDR environment "Empty Warehouse 01" (Poly Haven, CC0) at 0.9, one key light, neutral tone mapping, VSM shadows; the same in every condition.
- **Conditions:**
  1. `standard`;
  2. `occlusion`: a 40 × 40 mm cable duct between the part and the inspection camera, one third of the way to the camera, high enough that 55–75 % of the part stays visible to that camera (target 65 %). The duct is modelled in the twin;
  3. `limited`: the inspection camera panned until 55–75 % of the part stays in its frame (target 65 %). The panned pose is known to the twin;
  4. `reflective`: the part's material replaced by polished metal (metalness 1, roughness 0.06).
- **Generator inputs:** per view, the object on white in a square crop 1.35 × the mask's larger side, resampled to 512². Masks are exact renders. A view with fewer than 400 mask pixels gets no crop.

## 4. Generator

Hunyuan3D 2.1 job service, the same settings for every job: 30 steps, octree resolution 256, guidance 5, seed 1234, texture on. Each job is keyed by the SHA-256 of its crop, so an identical crop is generated once (`benchmark/cache/parts-recon/<sha>.{glb,json}`, mapped by `index.json`). A job that fails or exceeds 10 minutes is a failed generation and counts as a failure in every arm that needed it. Reference meshes are never substituted for outputs.

In our deployment the generator was nearly deterministic: rerunning every bracket crop with another seed value returned byte-identical meshes in 19 of 20 cases. The stored reconstructions are therefore the record: every downstream number is recomputed from them without a GPU, whereas regenerating them may give different meshes.

The cache also holds the reconstructions of crops that no arm used for its reported result (for example the second view in trials where C stopped after one generation); E1 depends on them.

## 5. Arms

What each arm may use:

| Information | Naive | A | B | C | D |
|---|---|---|---|---|---|
| Inspection crop for generation | yes | yes | yes | yes | yes |
| Crops from other twin cameras | – | – | – | when verification fails | always |
| Masks from the twin cameras with a crop (≥ 400 mask pixels) | inspection | yes | yes | yes | yes |
| Twin occluders (cell, duct) and support height | yes | yes | yes | yes | yes |
| Declared size (asset record) | – | – | yes | yes | yes |
| CAD, feature list, poses, ground truth | never | never | never | never | never |

- **Naive:** the mesh dropped at the inspection mask's centroid on the support plane, scaled to 15 cm, without rotation.
- **A:** the inspection-crop mesh registered with all cameras on the support plane (4 DoF), no size prior.
- **B:** the same mesh, registered with the declared longest dimension as a log-scale prior (λ = 0.5).
- **C, evidence-driven regeneration** (`benchmark/lib/grounding-src/policy.ts`):
  1. generate from the inspection crop (or, without one, the view with the largest mask) and register as in B;
  2. *verify* with twin information only: minimum IoU over all cameras ≥ τ = 0.90, and registered height and longest dimension each within 10 % of the declared values;
  3. if verification fails and the budget allows, generate from the unused view with the largest mask, register and verify again; budget: 2 generations;
  4. accept the first candidate that verifies; if none does, keep the one with the highest minimum IoU, flagged *unverified*. Every decision is logged.
- **D, generation-budget control:** always generates from the same two views as C and keeps the candidate with the higher minimum IoU. If C matches D's failures with fewer generations, the saving comes from the stopping rule.
- **E1, single generation:** one generation from the view with the largest mask (ties: inspection), or from the side camera, registered as in B.
- **E2, held-out camera:** the arm-B mesh, re-registered on two cameras; the third camera's IoU is computed for each of the three choices of held-out camera. Placement failures are recomputed for each two-camera fit, so they differ from B's.

**Registration** (`registration.ts`), identical in every arm: silhouette IoU against each camera's mask at 256 px, with the cell and duct rendered as occluders; CMA-ES, seed 3, four yaw starts (0°, 90°, 180°, 270°) × 120 evaluations, then 360 refinement evaluations of the best start.

τ = 0.90 and the 10 % tolerance were fixed on the bracket: among its two-camera registrations, τ = 0.90 flags all three with centre error above 5 mm plus one other, whereas 0.85 flags one of the three.

## 6. Metrics

All metrics are computed in the twin's world frame after registration from twin information only. There is no alignment, rescaling or ICP to ground truth: placement and scale errors count in full.

- **Placement:** distance between the centres of the world-axis-aligned bounding boxes of the registered mesh and the posed CAD (mm). Boxes are computed from world-space vertices (`Box3.setFromObject(object, true)`). three.js's default box, built from transformed local boxes, inflates under rotation; its values are kept in every row (`boxOfBoxes`) and its failure counts reported as a sensitivity, and `benchmark/out/box-of-boxes/` holds a complete run that used it throughout.
- **Size:** relative error of the bounding-box diagonal (%).
- **Dimensions:** height, and long and short sides of the minimum-area footprint rectangle, against the CAD measured the same way.
- **Shape:** Chamfer distance (mean of the two directions' mean point-to-surface distances) and Hausdorff distance (maximum over 6,000 area-uniform samples per direction, a sampled lower estimate).
- **Agreement:** silhouette IoU per camera.
- **Coverage:** fraction of surface area observed by the camera(s) whose images produced the mesh; visibility tolerance 0.1 % of the model's bounding-box diagonal, grazing limit 80°.
- **Features:** the depth-profile test of §7.
- **Failure (primary outcome):** centre error > 10 mm, or |size error| > 10 %, or no mesh.
- **Cost:** generations per trial, registration time, generation time.

## 7. Feature test

For each feature listed in `part.json` (CAD frame, converted with the trial pose):

1. **Probes:** a grid of lines parallel to the feature axis over a square of half-size 2.0 × the feature's lateral radius (diameter/2, outer diameter/2, or length/2 for slots and pockets), spaced at half the smallest lateral radius, clamped to 0.5–2 mm. Each line starts 10 mm outside the entry point and runs the feature depth + 10 mm into the part (at most 70 mm); its value is the depth of the first surface hit.
2. **Reference profile** (CAD): base depth = median depth outside the feature's footprint. A probe is in the feature region if its depth differs from the base by more than half the feature depth (or height, for bosses), and in the surround if it differs by less than a quarter.
3. **Reconstruction profile:** the same probes on the registered mesh, with its own base depth (median over the surround), so a uniform offset cancels.
4. **Scores:** *recall*, the fraction of feature-region probes whose depth differs from the reconstruction's base in the same direction by more than half the feature depth; *body*, the fraction of the surround's outer ring (probes at ≥ 1.7 × the lateral radius) that hits a surface within half the feature depth of the base (the whole surround when the outer ring has fewer than 8 probes at the feature's level); *area ratio*, probes deviating like a feature on the reconstruction versus the reference.
5. **Outcome:** `no-body` if body < 0.75; otherwise `recovered` if recall ≥ 0.6, `partial` if 0.25 ≤ recall < 0.6, `missing` below. Features shallower than 2 mm and bends are `not-tested`, because reconstruction surface noise is of that order.
6. **Visibility:** a feature is *seen* if at least half of its feature-region probe entry points are visible to the generating camera(s), with the cell, duct and part as occluders.

`recovered` measures depth-profile recovery only: an oversized feature can be recovered, and the area ratio is reported separately.

## 8. Metric validation

Before any reconstruction is measured, every metric is applied to the CAD at the trial poses and to copies with known errors (`benchmark/out/parts/metric-validation.json`, 84 checks):

- identity: every tested feature `recovered`, centre error 0;
- the same geometry under a local frame rotated 30° and 45° (centre and size error 0);
- translations of 2, 5 and 10 mm; uniform scales of 0.95 and 1.05;
- Gaussian vertex noise, σ = 0.5 and 1 mm;
- per part, one feature plugged (expected `missing`), enlarged × 1.6 (expected `recovered` with area ratio > 1.4), and moved one diameter sideways (expected `partial` or `missing`).

Pass: placement, size and dimension errors match the applied perturbation within 0.5 mm or 0.5 %; feature outcomes match their expectations; the identity recovers ≥ 95 % of tested features. Run with `partbench.html?stage=validate`.

## 9. Analysis

`benchmark/make-parts-tables.mjs` (H1–H5) and `benchmark/make-extra-tables.mjs` (E1, E2 and intervals) write `summary.json` files and the LaTeX macros the paper reads.

- **Unit and dependence:** 160 rows = 4 designs × 10 poses × 4 conditions. The four conditions reuse each pose, so rows are not independent.
- **Intervals:** 95 % percentile bootstrap, 50,000 resamples (seed 20261104), resampling the ten poses within each design and keeping all four conditions and all feature records of a pose together (`benchmark/analysis/pose_block.py`). They are conditional on the four designs. They replace the pooled tests specified before testing (Wilcoxon signed-rank, exact McNemar, a trial-clustered bootstrap), whose sampling assumptions ignore the shared poses; `make-parts-tables.mjs` still computes those as nominal values.
- **Reporting:** counts with denominators, per condition and in total; failures and generations side by side for every arm; every trial, including failed generations and unverified selections. No trial is excluded after outcomes are seen.
- **Verification as a trust signal:** the verdict (verified or flagged) against the placement criteria, for the first candidate and for the accepted one. It is a consistency check: the same cameras fit and verify, so it cannot detect an error shared by all cameras and the support.

## 10. Running the evaluation

Requirements: Node.js ≥ 20; a desktop browser with WebGL 2 (Chrome or Edge); Python 3 with NumPy for the intervals; for regeneration only, an image-to-3D service. The analysis scripts need only the stored results in `benchmark/out/`; the meshes (`fetch-meshes.mjs`) are needed only to rerun registration.

```bash
cd assets && npm ci
cd .. && node fetch-meshes.mjs                    # stored reconstructions from the v1.0 release
cd benchmark && node studio-server.mjs 8070
```

Then open, in order (each page writes its results under `benchmark/out/`):

| Step | Page or command | Output |
|---|---|---|
| Observation sets | `partbench.html?stage=observe&n=10` | `out/parts/<part>/observations.json`, crops |
| Metric validation | `partbench.html?stage=validate` | `out/parts/metric-validation.json` |
| Generation (needs a service) | `HY3D_URL=… node recon-parts.mjs` | `cache/parts-recon/` |
| Arms A–D | `partbench.html?stage=evaluate&budget=2` | `out/parts/<part>/results.json` |
| E1, E2 | `partbench.html?stage=baselines`, `partbench.html?stage=heldout` | `out/parts-extra/{baselines,heldout}/<part>.json` |
| Analysis | `node make-parts-tables.mjs`, `python analysis/pose_block.py`, `node make-extra-tables.mjs` | `paper-data/*.tex`, `summary.json` files |

The bracket benchmark runs the same way from `bench.html` (`stage=eval`, `stage=sensitivity`) followed by `node make-tables.mjs`.

Practical notes:

- Registration is seeded and deterministic: rerunning a stage on the stored meshes reproduces the stored outcomes, which is the first check on a new machine.
- Add `&part=<id>` (and, for `evaluate`, `&cond=<c>`, merged by `merge-parts-results.mjs`) to split a stage across browser tabs. Background tabs run more slowly.
- The Hunyuan3D 2.1 service fails when jobs run concurrently; `recon-parts.mjs` runs one at a time by default.
- `evaluate&dryrun=reference&cond=standard` substitutes the CAD for every reconstruction in the standard condition: a code check that gives the registration floor (below 0.4 mm on all four parts; stored as `results-dryrun.json`, the command writes `results-dryrun-standard.json`). Other conditions were not run with the CAD.

## 11. Reference results

The numbers this repository reproduces (all from the stored reconstructions).

| Result | Value |
|---|---|
| Bracket, two cameras + declared size: median centre error | 1.9 mm (naive drop 24.3 mm); 19/20 within 10 mm |
| Bracket, hidden mounting holes recovered | 0/17 (visible: 10/23) |
| Held-out parts, standard, B: median centre error, pooled | 1.8 mm (naive 15.7 mm) |
| H1 per part (B median vs naive, mm): fixture block, flange, housing, sheet mount | 1.8 vs 15.0, 3.7 vs 2.3, 1.9 vs 26.1, 2.0 vs 47.9: all ≤ 10 mm, B below naive for 3 of 4, so H1 as stated is not supported |
| Failures A / B / C / D (of 160) | 77 / 72 / 3 / 3 |
| Failures B / C with three.js's default box (the fixed protocol's metric) | 79 / 18 |
| B failures repaired / introduced by C | 69 / 0 |
| B→C failure reduction | 43 percentage points (95 % interval 36–51) |
| Generations per trial C / D | 1.66 / 2.00 |
| First candidate: failures flagged by verification | 72/72 |
| Accepted candidate: verified and correct / verified | 112/113 |
| Feature recovery, visible / hidden (B) | 211/982 (21 %) / 89/858 (10 %) |
| E1: failures with one generation, largest mask first / side only | 13/160 / 8/160 (160 generations each) |
| E1: replayed candidates that coincide with a stored registration, reproduced | 155/155 (largest mask), 120/120 (side); 5 and 40 are new outcomes |
| E2: failures of the two-camera fits flagged by the held-out camera (held out: inspection / side / fence) | 69/76 / 74/74 / 71/76 |
| E2: the same failures flagged by the check on the two fitted cameras | 76/76 / 73/74 / 76/76 |
| E2: correct placements flagged by the held-out camera | 20/84 / 36/86 / 22/84 |
| E2: failures passing both the fitted check and the held-out camera | 0 in every fold |
| E2: Spearman ρ, held-out IoU vs Chamfer distance | −0.85 / −0.88 / −0.83 |

## 12. Recommendations for new studies

What running this evaluation taught us, for anyone extending it:

- **Keep a generation-budget control.** Without D, the benefit of regeneration cannot be separated from simply generating more.
- **Report the verdict with its target.** "Verified" here means placement-consistent; every verified candidate still lacked at least one tested feature. Store what a verdict checks next to it.
- **Choose the first view deliberately, but keep the fallback.** One generation from the camera with the largest mask fails in 13/160 trials, against 3/160 for C at 1.66 generations per trial, so view choice recovers most but not all of the benefit. The side camera alone fails in 8/160 (0 in the standard condition): here it happens to be the better-placed camera, and the occlusion and limited view degrade only the inspection camera. In a real cell any camera can be the degraded one, and under the reflective finish side-only still fails 7 times against C's 2. Starting from the largest mask and keeping verification with regeneration combines both.
- **A held-out camera checks, but does not replace, the fitted check.** Fitting on two cameras and scoring the third flags 69–74 of the 74–76 failures, slightly fewer than the check on the fitted cameras (73–76), and flags 20–36 of 84–86 correct placements; no failure passes both. Whether a held-out camera helps when calibration is wrong is untested here (all cameras are exactly calibrated), and neither check can detect an error shared by all cameras and the support.
- **Compute boxes from vertices** and include rotated-local-frame cases in metric validation; box-of-boxes extents inflate size errors by up to 57 % for unchanged geometry.
- **Resample whole poses** when conditions reuse them, and state the design population the intervals refer to.
- **Key generations by input hash** and store every job record; it makes the whole evaluation replayable without a GPU.
- **Calibrate camera extrinsics to a fraction of a degree:** on the bracket, a 0.5° orientation error raises the median centre error from 1.9 to 7.8 mm.
- **Next steps the current set cannot answer:** real photographs and segmentation before generation; combined, drifting calibration errors against the verdict; more design families and larger, non-upright objects; other generators; measured rather than CAD-derived declared sizes.

## 13. Limitations

All inputs are rendered images with exact masks from exactly calibrated cameras. The test parts are four CAD designs authored with knowledge of the method, with CAD-derived declared sizes. Verification shares cameras with fitting. Deviation maps show reconstruction error against the rendered CAD, not manufacturing deviations.

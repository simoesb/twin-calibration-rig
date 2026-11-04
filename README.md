# The Digital Twin as Calibration Rig: evaluation kit

Code, data and protocol for *The Digital Twin as Calibration Rig: Grounding and Checking Generated 3D Geometry* (STAG 2026). A live digital twin's calibrated cameras, support surfaces and declared asset sizes are used to place a mesh from an image-to-3D generator metrically, to mark which of its surfaces the input camera could have observed, and to regenerate it from another camera when the twin's own checks fail.

Every number, table and plot in the paper is recomputed here from stored reconstructions, so no GPU or generator is needed. The evaluation itself is specified in [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md).

## Quick start

Requirements: Node.js ≥ 20, a desktop browser with WebGL 2 (Chrome or Edge), and Python 3 with NumPy for the interval analysis.

```bash
git clone https://github.com/simoesb/twin-calibration-rig.git && cd twin-calibration-rig
cd assets && npm ci && cd ..
cd benchmark
node make-tables.mjs                   # bracket benchmark tables, from out/results.json
node make-parts-tables.mjs             # held-out parts, arms A–D
python analysis/pose_block.py          # pose-block intervals
node make-extra-tables.mjs             # E1, E2 and the intervals
```

The scripts write `benchmark/paper-data/*.tex` and `*.dat`, the files the paper reads, and need only the stored results in `benchmark/out/`. To rerun registration, first fetch the stored reconstructions (about 4.2 GB) from the v1.0 release:

```bash
node fetch-meshes.mjs                  # from the repository root; checks every file
```

Then start the harness server (`node studio-server.mjs 8070` in `benchmark/`) and open the pages listed below.

## Layout

| Path | Content |
|---|---|
| `protocol/PROTOCOL.md` | The evaluation: hypotheses, data, arms, metrics, feature test, analysis, how to run it, reference results, recommendations. |
| `benchmark/lib/grounding-src/` | The method: registration (`registration.ts`, `cmaes.ts`), coverage (`coverage.ts`), deviation (`deviation.ts`), evidence shading (`shading.ts`), the regeneration policy (`policy.ts`), unit tests. |
| `benchmark/lib/grounding.js` | The same module bundled for the browser (`node lib/bundle-grounding.mjs`). |
| `benchmark/bench.{html,js}` | Bracket benchmark (development set). |
| `benchmark/partbench.{html,js}` | Held-out parts: observation sets, metric validation, arms A–D, E1, E2. |
| `benchmark/make-*.mjs`, `benchmark/analysis/` | Analysis scripts writing `paper-data/` and `summary.json` files. |
| `benchmark/recon.mjs`, `recon-parts.mjs` | Generator adapters (Hunyuan3D 2.1 job service). |
| `benchmark/studio*`, `gallery*`, `driver*` | Figure rendering (raster and path-traced close-ups). |
| `benchmark/out/` | Inputs and results: `trials.json`, crops and renders of the bracket; `parts/<part>/` observation sets, crops and `results.json`; `parts-extra/` E1, E2 and intervals; `box-of-boxes/` the held-out run with three.js's default box (a sensitivity, protocol §6). |
| `benchmark/out/parts/budget2-crops.json` | The second-view crops generated for the two-generation budget (input list for `recon-parts.mjs --list`). |
| `benchmark/cache/` | Reconstructions: `recon/trial-<i>.glb` (bracket), `parts-recon/<sha>.glb` keyed by crop hash with job records and `index.json`. Meshes come from the release (`fetch-meshes.mjs`). |
| `parts/` | The four held-out reference parts (CAD, GLB, features, perturbed copies). See `parts/README.md`. |
| `assets/` | Procedural cell and bracket (`build-assets.mjs`), part generation scripts (`pilot/`), and a live-twin demonstration on an AAS server (`demo-twin.mjs`). |
| `evidence/` | The evidence rules stored with a grounded part and their test (`npx tsx evidence-ablation.ts`). |
| `SHA256SUMS` | Checksums of every file, including the release meshes. |

## Reproducing the paper

Start `node studio-server.mjs 8070` in `benchmark/`, then:

| Paper item | How |
|---|---|
| Registration table, analysis figure, coverage and hidden-hole numbers | `bench.html?stage=eval` (about 40 min), then `node make-tables.mjs`. |
| Wrong priors and calibration | `bench.html?stage=sensitivity` (about 40 min; split with `&trials=a-b`), then `node make-tables.mjs`. |
| Frame time | `bench.html?stage=fps`, then `node make-tables.mjs`. Timings depend on the machine; the paper's GPU is recorded in `out/frametimes.json`. |
| Held-out parts: arms A–D, trust table | `partbench.html?stage=evaluate&budget=2` (split with `&part=<id>` and `&cond=<c>`, merged by `merge-parts-results.mjs`), then `node make-parts-tables.mjs`. |
| Single generation (E1), held-out camera (E2) | `partbench.html?stage=baselines`, `partbench.html?stage=heldout`, then `node make-extra-tables.mjs`. |
| Pose-block intervals | `python analysis/pose_block.py`, then `node make-extra-tables.mjs`. |
| Metric validation (84 checks) | `partbench.html?stage=validate`. |
| Registration floor with the true shapes (standard condition) | `partbench.html?stage=evaluate&dryrun=reference&cond=standard` (writes `results-dryrun-standard.json`; the stored run is `results-dryrun.json`). |
| Evidence close-ups of the bracket | `bench.html?stage=viz&trial=<i>`; path-traced with `driver.html`. |
| Held-out part close-ups | `gallery.html?part=<id>&trial=<i>&pass=coverage\|deviation\|groundtruth`. |
| Evidence rules | `cd evidence && npx tsx evidence-ablation.ts`. |
| Hole adjudication sheet | `bench.html?stage=holes` (after `stage=eval`); see below. |

Registration is seeded (`seed: 3`), so accuracy figures reproduce exactly on the stored reconstructions; rerunning a stage on a new machine should reproduce `results.json` before anything else is changed. The rendering pages need a visible browser tab; background tabs run, but more slowly.

Degraded masks: each registration mask (256 px) is eroded (half the trials) or dilated (the other half) by exactly 2 px, and 30 % of its boundary pixels are then flipped.

### Adjudicating the hole labels

`out/holes-sheet.png` shows each of the 40 true hole locations, from above, on the registered reconstruction. The part is dark, so openings show light; the orange circle is where the 7 mm hole should be. Tiles are shuffled, and nothing on the sheet says whether the camera saw the hole. For each tile, a rater fills in `label` in a copy of `out/holes-adjudication.json`:

- `present`: an opening covers the circle's centre;
- `offset`: an opening overlaps the circle but not its centre;
- `absent`: no opening overlaps the circle.

Join the copy with `out/holes-key.json` on `tile` to compare with the automatic labels and with visibility. Use two raters who have not seen the key.

## How it works

The pipeline has five stages. Each stage reads the previous stage's files, so any stage can
be rerun or replaced on its own.

```
assets ──► render ──► reconstruct ──► eval ──► tables
 (GLB)     (images,     (generator,     (register,      (results.tex)
           masks,        any model)      coverage,
           trials.json)                  deviation,
                                         features)
```

1. **Assets** (`assets/build-assets.mjs`). Builds the cell and the ground-truth part as
   GLB files. Units are metres and Y is up.

2. **Render ground truth** (`bench.html?stage=render&n=20&seed=20261005`).
   - Places the reference part at a random position and yaw on the inspection-plate top
     (`PLATE` in `bench.js`).
   - Renders it from the two twin cameras (`CAMS`).
   - Renders its object mask with the cell as occluder.
   - Saves the masked, square crop the generator receives.
   - Writes `out/trials.json` with the cameras and poses.

3. **Reconstruct** (`recon.mjs`). Sends each `trial-<i>-crop.png` to the generator and
   stores `cache/recon/trial-<i>.glb`. This is the only stage that talks to a generator.

4. **Evaluate** (`bench.html?stage=eval`). For every reconstruction:
   - Re-renders the ground-truth masks from both cameras at 256 px.
   - Registers the mesh under eight variants:
     - `naive`: dropped at the mask centroid, fixed 15 cm, no rotation;
     - `silhouette`: 7 DoF;
     - `silhouetteLong`: 7 DoF with eight yaw starts and 6.3× the evaluations
       (search budget vs identifiability);
     - `support`: 4 DoF on the support plane;
     - `supportDeclared`: plus the declared-size prior;
     - `supportDeclaredTurned`: the same mesh turned 45° about +Y first (the prior must
       not care);
     - `twoViews`: plus the second camera;
     - `twoViewsNoisy`: with eroded or dilated, jittered registration masks.
   - Scores each variant against the ground truth: centre error, size error, Chamfer and
     Hausdorff distances, IoU, and the pose.
   - For the single-camera variants, also the IoU in the held-out cell camera.
   - For `twoViews`, also computes:
     - observation coverage from the inspection camera;
     - deviation split into observed and inferred surface;
     - the hidden-feature test on the two mounting holes;
     - the scale–depth family (the model scaled by k about the inspection camera);
     - timings.
   - `?recon=<dir>&set=core` evaluates another reconstruction set with the core variants
     only.

5. **Tables** (`make-tables.mjs`). Aggregates `results.json` into the macros and table rows
   the paper uses. Every table and plot comes from these scripts, as do most numbers in the text; the few quoted directly (individual trials, counts such as 1 of 80) can be read from `out/results.json` and `out/parts/*/results.json`.

### The method in brief (`lib/grounding-src/`)

- **`registerToSilhouettes(renderer, model, views, opts)`**: analysis-by-synthesis
  registration.
  - Each `view` is `{ camera, mask, width, height }`: a calibrated three.js
    `PerspectiveCamera` and a binary mask (`Uint8Array`, row-major from the top-left,
    non-zero = object).
  - The energy is 1 − mean IoU over the views, plus `priorWeight · log²(scale · extent /
    declaredSize)` (`priorWeight` 0.5). `extent` is `longestDimension`: the larger of the
    height and the long side of the minimum-area footprint rectangle. It doesn't change
    with the mesh's yaw, and it assumes the mesh is +Y up.
  - `init` starts the search from a given pose instead of the multi-start (diagnostics).
  - Optimisation is CMA-ES. With `supportY` it optimises (x, z, yaw, log s) with the
    bounding-box bottom on the plane; without it, it optimises 7 DoF.
  - It runs from four yaw starts (`yawStarts`, 120 evaluations each), then refines the
    best for 360 evaluations.
  - `occluders` are rendered depth-only, so a partly hidden part is compared with its
    visible silhouette.
- **`computeCoverage(model, cameras, { grazingDeg: 80, occluders, samples })`**:
  - Per-vertex observation quality `q = max_k |n·v_k|`, counted only for cameras where
    the point is inside the frustum, visible, and not grazing.
  - Visible means a BVH ray test against model and occluders: the first hit lies within
    `visibilityTolerance(model)` of the point. That tolerance is 0.1 % of the model's own
    bounding-box diagonal, so distant scene geometry cannot change it, and the front of a
    thin wall hides its back.
  - Also returns the observed fraction of surface area from area-uniform samples.
- **`computeDeviation(model, reference, samples)`**:
  - Signed per-vertex distance to the reference via a BVH closest-point query: the sign
    comes from the face normal, with ray-parity near edges.
  - Forward and backward statistics, Chamfer and Hausdorff distances.
  - `deviationByCoverage` splits the forward statistics into observed and inferred
    surface.
- **`applyCoverageShading` / `applyDeviationShading`**: the evidence encodings, written as
  vertex attributes plus a small shader extension. These are the same encodings the
  paper's figures show.

## Using different models

### A different image-to-3D generator

Write an adapter in place of `recon.mjs`. The rest of the pipeline only needs this
contract:

- **Input:** `out/trial-<i>-crop.png`, 512 × 512 RGB, the object masked on a white
  background. To feed a generator a different crop (resolution, padding, background),
  change the crop block in `renderTrials()` in `bench.js` and rerun `stage=render`. The
  poses come from the same seed.
- **Output:** `cache/recon/trial-<i>.glb`, any triangle mesh.
  - Its frame, scale and position are free: registration recovers them. Non-watertight
    meshes and flipped normals are fine.
  - **The mesh must be Y-up**: the part's resting face toward −Y, as GLB requires. With a
    support plane, registration only searches yaw about Y. If your generator writes Z-up
    or a canonical frame that tilts the part, rotate it to Y-up in the adapter.
  - Optionally write `trial-<i>-textured.glb` (figures), and `trial-<i>.json` with at
    least `{ "seconds": <job time> }`. `make-tables.mjs` reports the mean generation time
    from it.
- **Keep runs apart:** move `cache/recon/` aside (e.g. `cache/recon-hunyuan21/`) before
  writing a new generator's meshes. `eval` always reads `cache/recon/`.

Then run `stage=eval` and `node make-tables.mjs`. Trials without a mesh are skipped.

The included adapter targets a Hunyuan3D 2.1 job server (`HY3D_URL`), with settings
`steps 30, octree_resolution 256, guidance_scale 5, seed 1234, generate_texture true`. Its
API is:

| Request | Purpose |
|---|---|
| `POST /generate` (multipart: `image` plus settings) | Submit a job; returns `{ job_id }`. |
| `GET /jobs/<id>` | Poll the job; returns `{ status: queued \| running \| completed \| failed }`. |
| `GET /download/<id>/white` | Download the untextured mesh. |
| `GET /download/<id>/textured` | Download the textured mesh. |

Any other generator (TRELLIS, TripoSR, InstantMesh, SF3D, a commercial API) needs only the
fetch calls in that file changed.

### A different reference part for the bracket benchmark

1. Replace the ground truth.
   - Edit `machinedBracket()` / `bracketGeometry()` in `assets/build-assets.mjs` and run
     `npm run build`, or drop in your own `assets/out/bracket-reference.glb`.
   - Use metres, Y up, origin at the bottom centre, resting on its base.
2. In `benchmark/bench.js`, update the part's constants:
   - `DECLARED_SIZE`: the part's longest nominal dimension (what its AAS would declare).
     It drives the declared-size prior.
   - `NAIVE_SIZE`: the fit-to-size default of the naive baseline.
   - `HOLES` and `BASE_T`: the hidden-feature test. `holeFeatures()` checks vertical
     through-holes in a base plate. For other features (bosses, slots, side holes), adapt
     that function: a feature counts as seen if the input camera can see it, and as
     recovered if a ray probe finds the expected material, or none.
3. Rerun in order:
   - `stage=render`;
   - reconstruction;
   - `stage=eval`;
   - `make-tables.mjs`.

### A different cell, support surface or cameras

- **Cell geometry:** replace `assets/out/democell.glb` (any GLB). It serves as the occluder
  for masks, registration and visibility.
- **Support surface:** `PLATE` in `bench.js` is the plate-top centre (`supportY` = its y).
  The random pose range is in `renderTrials()`.
- **Cameras:** `CAMS` in `bench.js` uses `twinCamera(name, position, lookAt, vFovDeg,
  width, height)`.
  - Registration accepts any number of views. Add a view to the `views` arrays in
    `evaluate()` to test more cameras.
  - Coverage takes a camera list, so the coverage of a multi-camera cell is one call.
- **Camera conventions** (as stored in `trials.json`): three.js conventions.
  - `fov` is the vertical field of view in degrees.
  - `quaternion` is `[x, y, z, w]`; the camera looks down its local −Z.
  - Positions are in metres in the cell frame (Y up).

### Real photographs and a real segmenter

The benchmark renders masks to isolate grounding from segmentation; the `twoViewsNoisy`
variant only simulates segmentation error. To run on photographs:

1. Calibrate each camera: intrinsics give `fov` and aspect; extrinsics come from a marker
   or board in the cell frame.
2. Build a `RegistrationView` per photo from the calibrated camera and your segmenter's
   binary mask, at the registration resolution (256 px wide), row-major from the
   top-left.
3. Pass the views to `registerToSilhouettes` with `supportY` and `declaredSize` as above.

Ground truth then has to come from a measured pose: for example, the part placed at
marked positions on a calibrated board.

### Other ablations

The registration variants are the `variants` object in `evaluate()`. Add an entry there
to test new options (e.g. `yawStarts`, `priorWeight`, mask resolution, evaluation
budgets), and a matching row in `VARIANTS` in `make-tables.mjs`.

## Result fields (`out/results.json`)

`results[]` has one entry per trial: `{ i, variants, coverage, timing, holes, scaleFamily }`;
`referenceHoles` is the hole test applied to the CAD reference itself (all `recovered`).

| Field | Meaning |
|---|---|
| `variants.<name>.centreErrMm` | Distance between bounding-box centres of the placed and true part. |
| `variants.<name>.sizeErrPct` | Relative error of the bounding-box diagonal (signed). |
| `variants.<name>.chamferMm` | Symmetric Chamfer distance (6 000 samples per direction). |
| `variants.<name>.hausdorffMm` | Hausdorff distance: the maximum over the same samples. |
| `variants.<name>.forwardP95Mm`, `backwardP95Mm` | 95th percentiles of forward and backward distances. |
| `variants.<name>.iou` | Final IoU per fitted view. |
| `variants.<name>.heldOutIoU` | Single-camera variants: IoU in the cell camera, which was not fitted. |
| `variants.<name>.pose` | The registered pose: `{ position, rotation, scale }` of the model's bottom centre. |
| `variants.<name>.evals` | Energy evaluations. |
| `variants.<name>.ms` | Registration time. |
| `variants.<name>.scale` | Recovered scale factor. |
| `coverage.fraction` | Observed fraction of surface area (inspection camera). |
| `coverage.observed`, `coverage.inferred` | Deviation statistics (mm) and area fraction on observed and inferred surface. `p95` is per trial; the paper averages it over trials. |
| `timing.coverageMs`, `deviationMs`, `triangles` | Cost of the evidence computation on the reconstruction. |
| `holes[]` | Per mounting hole: `seen` (opening visible to the input camera) and `outcome`: `recovered`, `missing` (material at the centre), `wrong-size` (opening diameter off by more than 50 % from the reference's, probed the same way), or `no-plate` (plate absent around the hole). Also `plateSupport`, `openingMm` and `referenceOpeningMm`. |
| `scaleFamily[]` | For k in 0.5…2: IoU in both cameras, and height of the base above the support, when the registered model is scaled by k about the inspection camera's centre. |

## Limitations of the data

- All images are renders of the modelled cell, not photographs.
- Masks are exact, except in the degraded-mask variant (and the optional segmentation-like crops).
- The bracket benchmark has one part family; the held-out experiment has four parts of four
  families, designed by the authors. All parts rest upright on a known surface. The bracket's
  hole test is specific to through-holes in a plate; the held-out parts use the generic
  depth-profile test.
- Calibration and prior errors are simulated.
- See the Limitations paragraph of the paper and protocol §13.

## Citation

```bibtex
@inproceedings{Simoes2026CalibrationRig,
  author    = {Simoes, Bruno},
  title     = {The Digital Twin as Calibration Rig: Grounding and Checking Generated 3D Geometry},
  booktitle = {Smart Tools and Applications in Graphics (STAG)},
  publisher = {The Eurographics Association},
  year      = {2026}
}
```

## Licence

Code: MIT (`LICENSE`). Data, parts, results, stored reconstructions and documentation: CC BY 4.0 (`LICENSE-DATA`), which also lists third-party material with its own terms.

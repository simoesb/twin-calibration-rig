# Reference parts

The four held-out test parts, one folder each, and a template for adding parts.

| Part | Family | Envelope (mm) | Notable features |
|---|---|---|---|
| `pilot-fixture-block` | prismatic, machined | 160 × 100 × 38 | pocket, island, counterbored and cross-drilled holes, hidden rear port |
| `pilot-flange-adapter` | turned | 150 × 150 × 40 | stepped bore, seal groove, eight counterbored holes on a bolt circle, asymmetric dowel, radial port |
| `pilot-bearing-housing` | cast | 174 × 74 × 103 | webs, slotted feet, lubrication port into the bore |
| `pilot-sheet-metal-mount` | sheet metal | 120 × 79 × 107 (3 mm sheet) | two bends, vent slots, sensor bore |

The parts are original parametric designs (`assets/pilot/build_pilot.py`, CadQuery), exact solids reviewed against common design rules.

## Folder contents

```
<part-id>/
  model.step              exact CAD (mm, Z up)
  model.glb               the same part for the benchmark: metres, +Y up, resting base at y = 0
  model.stl, render-mesh.json, studio.blend   exports used for rendering
  part.json               metadata and feature list (below)
  perturbed/              copies with known feature errors for metric validation (assets/pilot/perturb_parts.py)
  preview.png, reverse.png  presentation renders; never generator inputs
  validation.json, delivery-validation.json  geometry checks of the exports
```

## part.json

The benchmark reads `declaredSize` and `features`; the other fields document the part.

| Field | Meaning |
|---|---|
| `id`, `name`, `category` | Folder name, readable name, design family. |
| `units` | `mm`. |
| `declaredSize` | `{ length, width, height }`: the nominal dimensions an asset record would declare. Here taken from the CAD. |
| `material` | Material and finish; sets the rendered appearance. |
| `restingFaces` | Outward normal(s) of the face the part rests on, in CAD coordinates, e.g. `[[0, 0, -1]]`. |
| `features` | One entry per feature for the feature test (protocol §7): a unique `id`, `type` (`through-hole`, `blind-hole`, `counterbore`, `slot`, `pocket`, `boss`, `cross-port`, …), `center` and `axis` in CAD coordinates, and its dimensions (`diameter` or `width`/`length`, `depth`). |
| `cadCoordinateSystem`, `meshCoordinateSystem` | Frames of `model.step` and `model.glb` (CAD mm Z-up → GLB `[x, z, −y] / 1000`). |

## Adding a part

1. Create `parts/<id>/` with `model.glb` (metres, +Y up, base at y = 0) and a `part.json` from `_template/`, listing its features in CAD coordinates.
2. Add the id to `PARTS` in `benchmark/partbench.js`, `make-parts-tables.mjs`, `make-extra-tables.mjs` and `analysis/pose_block.py`. The analyses assume 10 poses and the four conditions per part.
3. Optionally create perturbed copies for metric validation (`perturb_parts.py` shows how).
4. Run the stages of protocol §10 for that part (`&part=<id>`).

Parts with rotational symmetry make yaw ambiguous; thin, shiny or black parts are hard for both segmentation and generation. A useful test set mixes families and includes such cases on purpose.

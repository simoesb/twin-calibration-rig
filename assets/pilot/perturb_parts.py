"""Perturbed copies of the reference parts, with known feature errors, for metric validation.

For one drilled feature per part (the first through- or blind-hole of at least 5 mm diameter),
writes parts/<id>/perturbed/<kind>.glb (metric, +Y up, as model.glb):
  plugged   the hole filled to its full depth          (expected outcome: missing)
  enlarged  the hole widened to 1.6 x its diameter     (expected: recovered, region area > 1.4x)
  shifted   the hole filled and re-drilled one diameter sideways (expected: partial or missing)
and parts/<id>/perturbed/perturbations.json. Validates measurements only; no reconstruction is
involved. Run with the CAD environment (requirements-lock.txt): python perturb_parts.py
"""
import json
from pathlib import Path
import cadquery as cq
import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[2]
PARTS = ROOT / 'parts'
IDS = ['pilot-fixture-block', 'pilot-flange-adapter', 'pilot-bearing-housing', 'pilot-sheet-metal-mount']


def cyl(r, h, p, axis):
    return cq.Workplane(obj=cq.Solid.makeCylinder(r, h, cq.Vector(*p), cq.Vector(*axis)))


def lateral(axis):
    a = np.array(axis, float)
    t = np.cross(a, [0, 0, 1]) if abs(a[2]) < 0.9 else np.cross(a, [1, 0, 0])
    return t / np.linalg.norm(t)


def to_glb(shape, path):
    stl = path.with_suffix('.stl')
    cq.exporters.export(shape, str(stl), tolerance=.035, angularTolerance=.075)
    mesh = trimesh.load_mesh(stl, process=True)
    stl.unlink()
    # CAD mm, Z up -> GLB m, Y up: [x, y, z] -> [x, z, -y] / 1000
    m = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)
    m[:3, :3] *= 0.001
    mesh.apply_transform(m)
    mesh.export(path)


for pid in IDS:
    meta = json.loads((PARTS / pid / 'part.json').read_text(encoding='utf8'))
    base = cq.importers.importStep(str(PARTS / pid / 'model.step'))
    f = next(x for x in meta['features'] if x['type'] in ('through-hole', 'blind-hole') and x['diameter'] >= 5)
    c, ax, d, depth = np.array(f['center'], float), np.array(f['axis'], float), f['diameter'], f['depth']
    start = (c - ax * 0.02).tolist()
    plug = cyl(d / 2 + 0.4, depth + 0.02, start, ax.tolist())   # +0.4 mm also fills the entry chamfer
    out = PARTS / pid / 'perturbed'
    out.mkdir(exist_ok=True)
    side = lateral(ax) * d
    variants = {
        'plugged': base.union(plug),
        'enlarged': base.cut(cyl(0.8 * d, depth + 0.04, start, ax.tolist())),
        'shifted': base.union(plug).cut(cyl(d / 2, depth + 0.04, (c + side - ax * 0.02).tolist(), ax.tolist())),
    }
    for kind, shape in variants.items():
        to_glb(shape, out / f'{kind}.glb')
    (out / 'perturbations.json').write_text(json.dumps({
        'feature': f['id'], 'diameterMm': d, 'depthMm': depth,
        'variants': {
            'plugged': {'expected': 'missing'},
            'enlarged': {'expected': 'recovered', 'expectedAreaRatioAbove': 1.4, 'diameterMm': 1.6 * d},
            'shifted': {'expected': ['partial', 'missing'], 'offsetMm': d, 'direction': (side / d).tolist()},
        },
        'note': 'Measurement validation only; CAD frame (mm, Z up) for the feature, GLB metric +Y up.',
    }, indent=2), encoding='utf8')
    print(pid, f['id'], 'd', d)

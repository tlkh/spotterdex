"""Pure geometry contracts for the procedural F-2A blockout.

These tests intentionally avoid importing ``bpy`` or asserting the current
aircraft proportions.  Blender-side visual review owns those decisions; this
module protects the reusable mesh builders from malformed indices and zero
area faces during iteration.
"""
from __future__ import annotations

import importlib.util
from collections import Counter
import math
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "aircraft-3d" / "blender" / "f2a_blockout.py"
SPEC = importlib.util.spec_from_file_location("spotterdex_f2a_blockout", MODULE_PATH)
assert SPEC and SPEC.loader
BLOCKOUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BLOCKOUT)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _face_area(vertices, face):
    origin = vertices[face[0]]
    area = 0.0
    for index in range(1, len(face) - 1):
        cross = _cross(_sub(vertices[face[index]], origin), _sub(vertices[face[index + 1]], origin))
        area += 0.5 * math.sqrt(sum(value * value for value in cross))
    return area


def _assert_valid_mesh(testcase, mesh):
    vertices, faces = mesh[:2]
    testcase.assertTrue(vertices)
    testcase.assertTrue(faces)
    for face in faces:
        testcase.assertGreaterEqual(len(face), 3)
        testcase.assertEqual(len(face), len(set(face)), f"duplicate index in {face}")
        testcase.assertTrue(all(0 <= index < len(vertices) for index in face), f"bad index in {face}")
        testcase.assertGreater(_face_area(vertices, face), 1e-8, f"zero area face {face}")


class F2ABlockoutGeometryTests(unittest.TestCase):
    def test_airfoil_mesh_preserves_outline_and_is_manifold(self):
        spec=((2.0,.5,-1.5),(-3.,-2.8,-2.2),(.7,2.5,5.4),(.15,.1,.05),(.12,.08,.025))
        for sign in (-1,1):
            vertices,faces=BLOCKOUT._airfoil_mesh(sign,*spec)
            _assert_valid_mesh(self,(vertices,faces))
            edges=Counter(tuple(sorted((f[i],f[(i+1)%len(f)]))) for f in faces for i in range(len(f)))
            self.assertTrue(all(n==2 for n in edges.values()))
            self.assertAlmostEqual(max(sign*y for x,y,z in vertices),5.4)
            self.assertAlmostEqual(max(x for x,y,z in vertices),2.0)
            self.assertAlmostEqual(min(x for x,y,z in vertices),-3.0)
            self.assertLessEqual(max(z for x,y,z in vertices),.15+.12+.0041)
            self.assertGreaterEqual(min(z for x,y,z in vertices),min(b-t for b,t in zip(spec[3],spec[4]))-.0001)
        with self.assertRaises(ValueError):
            BLOCKOUT._airfoil_mesh(1,(0,1),(1,2),(.5,1),(.1,.1),(.1,.1))

    def test_longitudinal_loft_faces_are_valid(self):
        mesh = BLOCKOUT._loft(((7.7, 0.05, 0.05, 0.5), (5.0, 0.8, 0.6, 0.5),
                               (0.0, 1.5, 1.0, 0.4), (-7.7, 0.7, 0.5, 0.5)), segments=24)
        _assert_valid_mesh(self, mesh)

    def test_half_loft_canopy_faces_are_valid(self):
        mesh = BLOCKOUT._half_loft(((5.2, 0.1, 0.1, 0.9), (3.8, 0.7, 0.45, 1.0),
                                    (2.3, 0.5, 0.25, 0.85)), segments=16)
        _assert_valid_mesh(self, mesh)

    def test_fin_and_inlet_builders_are_closed_by_valid_faces(self):
        _assert_valid_mesh(self, BLOCKOUT._fin_mesh())
        _assert_valid_mesh(self, BLOCKOUT._inlet_mesh())
        _assert_valid_mesh(self, BLOCKOUT._root_fairing())

    def test_fairing_and_duct_are_manifold_and_symmetric(self):
        for builder in (BLOCKOUT._root_fairing, BLOCKOUT._inlet_mesh):
            vertices, faces = builder()[:2]
            edges = Counter(tuple(sorted((f[i], f[(i+1)%len(f)])))
                            for f in faces for i in range(len(f)))
            self.assertTrue(all(n == 2 for n in edges.values()))
            by_x = {}
            for x,y,z in vertices:
                by_x.setdefault(x, []).append((y,z))
            for x,y,z in vertices:
                self.assertTrue(any(abs(y+yy)<1e-8 and abs(z-zz)<1e-8 for yy,zz in by_x[x]))

    def test_loft_caps_share_all_boundary_edges(self):
        stations = ((5.2, .1, .1, .9), (3.8, .7, .45, 1.0), (2.3, .5, .25, .85))
        for builder in (BLOCKOUT._loft, BLOCKOUT._half_loft):
            _, faces = builder(stations)
            edges = Counter(tuple(sorted((face[i], face[(i + 1) % len(face)])))
                            for face in faces for i in range(len(face)))
            self.assertTrue(all(count == 2 for count in edges.values()), builder.__name__)


if __name__ == "__main__":
    unittest.main()

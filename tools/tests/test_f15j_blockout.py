"""Pure geometry contracts for the F-15J neutral blockout.

Blender scene ownership and visual accuracy are checked by the live review
helper.  These tests protect station ordering, mirror symmetry, and closed
mesh index/area contracts without importing Blender.
"""
from __future__ import annotations

from collections import Counter
import importlib.util
import math
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "aircraft-3d" / "blender" / "f15j_blockout.py"
SPEC = importlib.util.spec_from_file_location("spotterdex_f15j_blockout", MODULE_PATH)
assert SPEC and SPEC.loader
BLOCKOUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BLOCKOUT)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def _face_area(vertices, face):
    origin = vertices[face[0]]
    return sum(.5 * math.sqrt(sum(v * v for v in _cross(
        _sub(vertices[face[i]], origin), _sub(vertices[face[i + 1]], origin))))
               for i in range(1, len(face) - 1))


def _assert_valid_mesh(testcase, mesh):
    vertices, faces = mesh[:2]
    testcase.assertTrue(vertices)
    testcase.assertTrue(faces)
    for face in faces:
        testcase.assertGreaterEqual(len(face), 3)
        testcase.assertEqual(len(face), len(set(face)), f"duplicate index in {face}")
        testcase.assertTrue(all(0 <= index < len(vertices) for index in face), f"bad index in {face}")
        testcase.assertGreater(_face_area(vertices, face), 1e-8, f"zero area face {face}")


class F15JBlockoutGeometryTests(unittest.TestCase):
    def test_planforms_have_strict_station_contract(self):
        for planform in (BLOCKOUT.MAIN_WING_PLANFORM, BLOCKOUT.STABILATOR_PLANFORM):
            spans = planform["spans"]
            self.assertEqual(tuple(sorted(spans)), spans)
            self.assertGreaterEqual(spans[0], 0)
            self.assertEqual(len(spans), len(planform["leading"]))
            self.assertEqual(len(spans), len(planform["trailing"]))
            self.assertTrue(all(le > te for le, te in zip(planform["leading"], planform["trailing"])))

    def test_airfoils_are_valid_and_mirrored(self):
        for planform in (BLOCKOUT.MAIN_WING_PLANFORM, BLOCKOUT.STABILATOR_PLANFORM):
            left = BLOCKOUT._airfoil_mesh(1, **planform)
            right = BLOCKOUT._airfoil_mesh(-1, **planform)
            _assert_valid_mesh(self, left)
            _assert_valid_mesh(self, right)
            self.assertEqual(len(left[0]), len(right[0]))
            self.assertEqual(len(left[1]), len(right[1]))
            self.assertTrue(all(abs(x - xx) < 1e-8 and abs(y + yy) < 1e-8 and abs(z - zz) < 1e-8
                                for (x, y, z), (xx, yy, zz) in zip(left[0], right[0])))
            edges = Counter(tuple(sorted((face[i], face[(i + 1) % len(face)])))
                            for face in left[1] for i in range(len(face)))
            self.assertTrue(all(count == 2 for count in edges.values()))

    def test_body_fairing_fin_and_shell_builders_have_valid_faces(self):
        builders = [
            lambda: BLOCKOUT._loft(((9.7, .03, .03, .2), (4, 1, .8, .1), (-7, .45, .35, .2))),
            BLOCKOUT._half_loft,
            lambda: BLOCKOUT._half_loft(((6, .2, .1, .8), (4, .6, .5, .75), (2.5, .3, .2, .7))),
            lambda: BLOCKOUT._fin_mesh(1),
            lambda: BLOCKOUT._root_fairing(1),
            lambda: BLOCKOUT._intake_mesh(1),
            lambda: BLOCKOUT._nozzle_shell(.66),
            lambda: BLOCKOUT._rect_cap(.95, .82, 1.28, .31, .05, .31),
            lambda: BLOCKOUT._cylinder_cap(-8.34, -8.50, .66, .18, .285),
        ]
        # Use explicit stations for the canopy builder entry.
        meshes = [builders[0](), builders[2](), builders[3](), builders[4](),
                  builders[5](), builders[6](), builders[7](), builders[8]()]
        for mesh in meshes:
            _assert_valid_mesh(self, mesh)

    def test_closed_shell_edges_are_two_sided(self):
        for mesh in (BLOCKOUT._loft(((9.7, .03, .03, .2), (4, 1, .8, .1), (-7, .45, .35, .2))),
                     BLOCKOUT._intake_mesh(1), BLOCKOUT._nozzle_shell(.66)):
            _, faces = mesh
            edges = Counter(tuple(sorted((face[i], face[(i + 1) % len(face)])))
                            for face in faces for i in range(len(face)))
            self.assertTrue(all(count == 2 for count in edges.values()))

    def test_envelope_landmarks(self):
        wing = BLOCKOUT._airfoil_mesh(1, **BLOCKOUT.MAIN_WING_PLANFORM)[0]
        stab = BLOCKOUT._airfoil_mesh(1, **BLOCKOUT.STABILATOR_PLANFORM)[0]
        self.assertAlmostEqual(max(y for _, y, _ in wing), 6.55, places=6)
        self.assertAlmostEqual(min(x for x, _, _ in stab), -9.68, places=6)
        self.assertGreater(min(x for x, _, _ in stab), -9.8)
        self.assertGreater(max(x for x, _, _ in wing), 0.95)


if __name__ == "__main__":
    unittest.main()

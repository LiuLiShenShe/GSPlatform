"""Numerical, topology, color and format tests against real exporter/validator."""

import json
import numpy as np
import pytest
from plyfile import PlyData, PlyElement
from workers.meshing.standard_asset import convert, digest, read_glb
from workers.meshing.asset_coordinates import ORIENTATIONS, rotation_matrix


def make_mesh(tmp_path):
    vertices = np.array(
        [
            (0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 12, 128, 240),
            (2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 220, 70, 3),
            (0.0, 3.0, 0.0, 0.0, 0.0, 1.0, 255, 255, 255),
            (0.3, 0.7, 1.2, 0.0, 0.0, 1.0, 42, 42, 42),
        ],
        dtype=[(n, "f8") for n in ["x", "y", "z", "nx", "ny", "nz"]]
        + [(n, "u1") for n in ["red", "green", "blue"]],
    )
    faces = np.array(
        [([0, 1, 2],), ([0, 3, 1],), ([1, 3, 2],), ([0, 2, 3],)],
        dtype=[("vertex_indices", "i4", (3,))],
    )
    p = tmp_path / "mesh.ply"
    PlyData(
        [PlyElement.describe(vertices, "vertex"), PlyElement.describe(faces, "face")],
        text=False,
    ).write(p)
    return p, vertices, faces


@pytest.mark.parametrize("axis", list(ORIENTATIONS))
def test_rigid_metric_color_topology_and_official_validation(tmp_path, axis):
    source, vertices, faces = make_mesh(tmp_path)
    original = source.read_bytes()
    dest = tmp_path / "mesh.glb"
    result = convert(source, dest, ORIENTATIONS[axis], digest(source), 4, 4)
    tree, attributes, indices = read_glb(dest)
    assert source.read_bytes() == original
    np.testing.assert_array_equal(indices, np.stack(faces["vertex_indices"]))
    xyz = np.column_stack([vertices[a] for a in ["x", "y", "z"]])
    m = np.array(result["sourceToAssetMatrix"])
    expected = xyz @ m[:3, :3].T + m[:3, 3]
    np.testing.assert_allclose(attributes["POSITION"], expected, atol=2e-7)
    assert result["pairDistanceMaxErrorMeters"] < 1e-6
    b = np.array(result["assetBounds"])
    assert abs(b[0, 1]) < 1e-7
    np.testing.assert_allclose((b[0] + b[1])[[0, 2]], 0, atol=1e-7)
    srgb = np.column_stack([vertices[a] for a in ["red", "green", "blue"]]) / 255.0
    expected_colors = np.where(
        srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4
    )
    np.testing.assert_allclose(attributes["COLOR_0"], expected_colors, atol=5e-8)
    assert not tree.get("extensionsRequired")
    assert result["validator"]["issues"]["numErrors"] == 0
    assert result["scaleApplied"] == 1


@pytest.mark.parametrize(
    "matrix",
    [
        np.diag([2, 1, 1]),
        np.diag([-1, 1, 1]),
        np.zeros((3, 3)),
        np.full((3, 3), np.nan),
    ],
)
def test_scale_reflection_and_nonfinite_are_forbidden(matrix):
    with pytest.raises(ValueError):
        rotation_matrix(matrix)


def test_source_checksum_blocks_export(tmp_path):
    source, _, _ = make_mesh(tmp_path)
    with pytest.raises(ValueError, match="checksum"):
        convert(source, tmp_path / "bad.glb", ORIENTATIONS["+Y"], "0" * 64, 4, 4)

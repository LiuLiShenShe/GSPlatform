"""Numerical checks against the real official geometry converter and renderer input."""

import math

import numpy as np
import pytest

from workers.meshing.confirmed_geometry import prepare
from workers.meshing.render_gsplat import parameters_from_ply
from workers.pipeline.gaussian_quality import read_gaussian_ply
from workers.tests.test_convert_scene_lod_recipe import _gaussian_ply_bytes


def test_confirmed_cleanup_and_scale_are_used_without_restoring_removed_gaussians(
    tmp_path,
):
    source = tmp_path / "saved-cleanup.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    before = read_gaussian_ply(source)
    selected = np.array(before)[[2, 11, 48]].copy()
    # A metric, saved geometry with points removed AND moved by the user.
    selected["x"] += 3.5
    header = source.read_bytes().split(b"end_header\n")[0] + b"end_header\n"
    header = header.replace(b"element vertex 64", b"element vertex 3")
    source.write_bytes(header + selected.tobytes())
    output = tmp_path / "camera-units" / "confirmed.ply"
    prepare(source, output, 0.08)
    actual = read_gaussian_ply(output)
    assert len(actual) == 3
    for axis in ("x", "y", "z"):
        np.testing.assert_allclose(
            actual[axis], selected[axis] / 0.08, rtol=2e-6, atol=1e-6
        )
    for i in range(3):
        np.testing.assert_allclose(
            actual[f"scale_{i}"], selected[f"scale_{i}"] - math.log(0.08), atol=1e-6
        )
    params = parameters_from_ply(output)
    assert params["means"].shape == (3, 3)
    np.testing.assert_allclose(
        params["means"].numpy() * 0.08,
        np.column_stack([selected[a] for a in ("x", "y", "z")]),
        rtol=2e-6,
    )
    np.testing.assert_allclose(params["opacities"].numpy(), selected["opacity"])
    np.testing.assert_allclose(
        params["sh0"].numpy()[:, 0],
        np.column_stack([selected[f"f_dc_{i}"] for i in range(3)]),
    )


@pytest.mark.parametrize("factor", [0, -1, math.inf, math.nan])
def test_invalid_metric_scale_never_runs_conversion(tmp_path, factor):
    with pytest.raises(ValueError, match="Invalid calibration"):
        prepare(tmp_path / "missing.ply", tmp_path / "result.ply", factor)

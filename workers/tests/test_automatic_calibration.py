import math
import struct

import numpy as np
import pytest

from workers.pipeline.calibrate_scene import scale_gaussians
from workers.pipeline.gaussian_quality import read_gaussian_ply


def test_real_official_uniform_scaling_preserves_geometry_and_attributes(tmp_path):
    names = [
        "x",
        "y",
        "z",
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "opacity",
        "scale_0",
        "scale_1",
        "scale_2",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    ]
    rows = [
        [x, y, z, 0.1, 0.2, 0.3, 1, -2, -3, -4, 1, 0, 0, 0]
        for x, y, z in [(1, 2, 3), (-2, 4, 1), (3, -1, 2)]
    ]
    header = "ply\nformat binary_little_endian 1.0\nelement vertex 3\n"
    header += "".join(f"property float {name}\n" for name in names) + "end_header\n"
    source = tmp_path / "source.ply"
    source.write_bytes(
        header.encode()
        + struct.pack("<" + "f" * 42, *(value for row in rows for value in row))
    )
    output = tmp_path / "work" / "scaled.ply"
    receipt = scale_gaussians(source, output, factor=0.08, expected_count=3)
    before, after = read_gaussian_ply(source), read_gaussian_ply(output)
    for axis in ("x", "y", "z"):
        np.testing.assert_allclose(after[axis], before[axis] * 0.08, rtol=1e-6)
    for axis in range(3):
        np.testing.assert_allclose(
            after[f"scale_{axis}"], before[f"scale_{axis}"] + math.log(0.08), rtol=1e-6
        )
    for name in (
        "opacity",
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    ):
        np.testing.assert_array_equal(before[name], after[name])
    assert receipt["gaussianCount"] == 3 and receipt["allGaussianAttributesChecked"]
    assert not (output.parent / "original.ply").exists()
    with pytest.raises(ValueError, match="preserve every Gaussian"):
        scale_gaussians(
            source, tmp_path / "bad" / "scaled.ply", factor=0.08, expected_count=4
        )

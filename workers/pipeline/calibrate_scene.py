"""Uniform metric scaling with the pinned official SplatTransform tool."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from workers.pipeline.gaussian_quality import read_gaussian_ply
from workers.pipeline.splat_transform_adapter import CLI_PATH, run_cli_command


def scale_gaussians(
    source: Path,
    output: Path,
    *,
    factor: float,
    expected_count: int,
    streamed: bool = False,
) -> dict:
    if not math.isfinite(factor) or factor <= 0:
        raise ValueError("Invalid calibration factor")
    output.parent.mkdir(parents=True, exist_ok=True)
    original = output.parent / "original.ply"
    selection = ["--select-lod", "0"] if streamed else []
    common = ["--no-tty", "--max-workers", "0", "-w"]
    run_cli_command(
        [str(CLI_PATH), "-g", "cpu", *selection, str(source), str(original), *common],
        cwd=output.parent,
        timeout=3600,
    )
    run_cli_command(
        [
            str(CLI_PATH),
            "-g",
            "cpu",
            str(original),
            "-s",
            str(factor),
            str(output),
            *common,
        ],
        cwd=output.parent,
        timeout=3600,
    )
    before, after = read_gaussian_ply(original), read_gaussian_ply(output)
    if len(before) != expected_count or len(after) != expected_count:
        raise ValueError("Automatic calibration must preserve every Gaussian")
    if before.dtype.names != after.dtype.names:
        raise ValueError("Calibration changed Gaussian properties")
    maximum_error = 0.0
    for name in before.dtype.names or ():
        values = before[name].astype(np.float64)
        expected = (
            values * factor
            if name in ("x", "y", "z")
            else (
                values + math.log(factor)
                if name in ("scale_0", "scale_1", "scale_2")
                else values
            )
        )
        actual = after[name].astype(np.float64)
        if not np.allclose(actual, expected, rtol=2e-5, atol=2e-6):
            raise ValueError(f"Calibration did not preserve uniform transform: {name}")
        if name in ("x", "y", "z"):
            maximum_error = max(maximum_error, float(np.max(np.abs(actual - expected))))
    original.unlink()
    return {
        "tool": "@playcanvas/splat-transform",
        "toolVersion": "3.3.3",
        "gaussianCount": len(after),
        "scaleFactor": factor,
        "allGaussianAttributesChecked": True,
        "maximumPositionError": maximum_error,
        "sourceLod": 0 if streamed else None,
        "origin": [0, 0, 0],
    }

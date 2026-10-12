"""Read-only measurements of uncompressed Gaussian PLY; never a cleanup algorithm."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from workers.pipeline.validate_editor_export import validate_editor_ply

PERCENTILES = (1, 5, 50, 95, 99)
CHUNK_ROWS = 131072


def read_gaussian_ply(path: Path) -> np.memmap:
    validate_editor_ply(path, 500_000_000)
    with path.open("rb") as stream:
        header = stream.read(65536)
    marker = header.index(b"end_header\n")
    lines = header[:marker].decode("ascii").splitlines()
    count = next(int(line.split()[2]) for line in lines if line.startswith("element vertex "))
    names = [line.split()[2] for line in lines if line.startswith("property float ")]
    return np.memmap(path, dtype=[(name, "<f4") for name in names], mode="r",
                     offset=marker + len(b"end_header\n"), shape=(count,))


def _distribution(values: np.ndarray) -> dict:
    finite = values[np.isfinite(values)]
    if not finite.size:
        return {"available": False, "nanCount": int(np.isnan(values).sum()),
                "infCount": int(np.isinf(values).sum())}
    return {"min": float(finite.min()), "max": float(finite.max()),
            "percentiles": {f"P{percentile:02}": float(value) for percentile, value in
                            zip(PERCENTILES, np.percentile(finite, PERCENTILES), strict=True)}}


def _occupancy_grid(rows: np.ndarray, ranges: list) -> np.ndarray:
    grid = np.zeros((32, 32, 32), dtype=np.int64)
    for start in range(0, len(rows), CHUNK_ROWS):
        coordinates = np.column_stack([rows[axis][start:start + CHUNK_ROWS]
                                       for axis in ("x", "y", "z")])
        grid += np.histogramdd(coordinates, bins=32, range=ranges)[0].astype(np.int64)
    return grid


def analyze_gaussian_ply(path: Path) -> dict:
    rows = read_gaussian_ply(path)
    names = rows.dtype.names or ()
    nonfinite = {name: {"nan": 0, "inf": 0} for name in names}
    for start in range(0, len(rows), CHUNK_ROWS):
        block = rows[start:start + CHUNK_ROWS]
        for name in names:
            nonfinite[name]["nan"] += int(np.isnan(block[name]).sum())
            nonfinite[name]["inf"] += int(np.isinf(block[name]).sum())
    positions = {axis: _distribution(rows[axis]) for axis in ("x", "y", "z")}
    if any("min" not in distribution for distribution in positions.values()):
        raise ValueError("Gaussian positions have no finite extent")
    bounds = {axis: [distribution["min"], distribution["max"]]
              for axis, distribution in positions.items()}
    robust = {axis: [distribution["percentiles"]["P01"], distribution["percentiles"]["P99"]]
              for axis, distribution in positions.items()}
    opacity = np.exp(-np.logaddexp(0, -np.asarray(rows["opacity"], dtype=np.float64)))
    maximum_scale = np.zeros(len(rows), dtype=np.float64)
    scales = {}
    for axis in range(3):
        with np.errstate(over="ignore", invalid="ignore"):
            linear = np.exp(np.asarray(rows[f"scale_{axis}"], dtype=np.float64))
        scales[f"scale_{axis}"] = _distribution(linear)
        np.maximum(maximum_scale, linear, out=maximum_scale)
    ranges = [robust[axis] if robust[axis][0] < robust[axis][1]
              else [robust[axis][0] - 0.5, robust[axis][1] + 0.5] for axis in ("x", "y", "z")]
    grid = _occupancy_grid(rows, ranges)
    occupied = grid[grid > 0]
    tails = {}
    for depth in (50, 100):
        selected = rows["y"] > depth
        tails[f"runtimeYBelowMinus{depth}"] = {
            "count": int(selected.sum()), "percentage": float(selected.mean() * 100),
            "sourceBounds": {axis: _distribution(rows[axis][selected]) for axis in ("x", "y", "z")},
            "opacity": _distribution(opacity[selected]),
            "maximumLinearScale": _distribution(maximum_scale[selected]),
        }
    rest_names = [name for name in names if name.startswith("f_rest_")]
    dc = {name: _distribution(rows[name]) for name in ("f_dc_0", "f_dc_1", "f_dc_2")}
    result = {
        "gaussianCount": len(rows), "bytes": path.stat().st_size, "properties": list(names),
        "coordinates": {"sourceToRuntime": "(-x, -y, z), baked Z180, identity world transform",
                        "units": "uncalibrated; not asserted to be meters"},
        "sourceBounds": bounds, "sourcePercentiles": positions, "sourceRobustP01P99Bounds": robust,
        "runtimeBounds": {"x": [-bounds["x"][1], -bounds["x"][0]],
                          "y": [-bounds["y"][1], -bounds["y"][0]], "z": bounds["z"]},
        "nonfinite": nonfinite, "opacitySigmoid": _distribution(opacity),
        "opacityCounts": {str(threshold): int((opacity < threshold).sum())
                          for threshold in (0.01, 0.05, 0.1)},
        "linearScaleExp": scales, "maximumLinearScale": _distribution(maximum_scale),
        "largeScaleCounts": {str(threshold): int((maximum_scale > threshold).sum())
                             for threshold in (2, 5, 10, 20)},
        "colorSH": {"higherSHBands": {0: 0, 9: 1, 24: 2, 45: 3}.get(len(rest_names), "unavailable"),
                    "dcCoefficients": dc, "restColumnCount": len(rest_names),
                    "dcOnlyRGBUnclipped": {name: _distribution(0.5 + 0.28209479177387814 * rows[name])
                                           for name in dc}},
        "spatialDensity": {"method": "32^3 center histogram inside exact P01/P99 bounds; not clustering",
                           "bounds": ranges, "occupiedCells": len(occupied),
                           "includedCenters": int(grid.sum()), "totalCells": int(grid.size),
                           "occupiedCellCounts": _distribution(occupied),
                           "maximumCellIndex": [int(value) for value in np.unravel_index(grid.argmax(), grid.shape)]},
        "positionalTailsNotDebrisClassification": tails,
        "gpuOverdraw": "unavailable", "gaussianWeightedVisualBounds": "unavailable",
    }
    return result


def compare_gaussian_ply(original: Path, candidate: Path) -> dict:
    before = analyze_gaussian_ply(original)
    after = analyze_gaussian_ply(candidate)
    original_rows = read_gaussian_ply(original)
    candidate_rows = read_gaussian_ply(candidate)
    preservation: bool | str = "unavailable"
    names = original_rows.dtype.names or ()
    if (set(names) == set(candidate_rows.dtype.names or ())
            and len(original_rows) <= 2_000_000 and len(candidate_rows) <= len(original_rows)):
        packed_dtype = np.dtype([(name, "<f4") for name in names])
        original_packed = np.empty(len(original_rows), dtype=packed_dtype)
        candidate_packed = np.empty(len(candidate_rows), dtype=packed_dtype)
        for name in names:
            original_packed[name] = original_rows[name]
            candidate_packed[name] = candidate_rows[name]
        original_keys, original_counts = np.unique(original_packed.view(f"V{packed_dtype.itemsize}"),
                                                   return_counts=True)
        candidate_keys, candidate_counts = np.unique(candidate_packed.view(f"V{packed_dtype.itemsize}"),
                                                     return_counts=True)
        indices = np.searchsorted(original_keys, candidate_keys)
        in_range = indices < len(original_keys)
        preservation = bool(in_range.all() and np.array_equal(original_keys[indices], candidate_keys)
                            and (candidate_counts <= original_counts[indices]).all())
    removed = before["gaussianCount"] - after["gaussianCount"]
    ranges = before["spatialDensity"]["bounds"]
    original_grid = _occupancy_grid(original_rows, ranges)
    candidate_grid = _occupancy_grid(candidate_rows, ranges)
    return {"original": before, "candidate": after, "removedCount": removed,
            "removedPercentage": removed / before["gaussianCount"] * 100,
            "retainedRowsBitIdenticalIncludingSH": preservation,
            "sharedSpatialOccupancy": {"method": "32^3 same original P01/P99 source-space grid",
                                       "bounds": ranges,
                                       "originalOccupiedCells": int((original_grid > 0).sum()),
                                       "candidateOccupiedCells": int((candidate_grid > 0).sum()),
                                       "newlyEmptyCells": int(((original_grid > 0) & (candidate_grid == 0)).sum()),
                                       "increasedCellCount": int((candidate_grid > original_grid).sum())},
            "visualApproval": "PENDING", "vrPerformance": "unavailable"}

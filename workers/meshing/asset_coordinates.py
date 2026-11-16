"""Shared, versioned rigid transforms. Never infer gravity from camera poses."""

import hashlib
import json

import numpy as np

TRANSFORM_VERSION = "RH_YUP_BOTTOM_CENTER_UNITS_V2"
CONVERTER_VERSION = "trimesh-4.11.4-linear-color-v2-units"
SOURCE_UNIT_TO_METERS = {"cm": 0.01, "m": 1.0}
# Proper rotations only (determinant +1), row-major, column-vector convention.
ORIENTATIONS = {
    "+Y": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    "-Y": [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    "+Z": [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
    "-Z": [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    "+X": [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    "-X": [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
}


def rotation_matrix(values):
    rotation = np.asarray(values, dtype=np.float64)
    if (
        rotation.shape != (3, 3)
        or not np.isfinite(rotation).all()
        or not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-9, rtol=0)
        or not np.isclose(np.linalg.det(rotation), 1, atol=1e-9)
    ):
        raise ValueError(
            "Only a proper rigid rotation is allowed; scale/reflection forbidden"
        )
    return rotation


def recipe_key(sha, rotation, source_units="m"):
    rotation_matrix(rotation)
    if source_units not in SOURCE_UNIT_TO_METERS:
        raise ValueError("Unsupported source mesh unit")
    return hashlib.sha256(
        json.dumps(
            [sha, rotation, source_units, CONVERTER_VERSION, TRANSFORM_VERSION],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()

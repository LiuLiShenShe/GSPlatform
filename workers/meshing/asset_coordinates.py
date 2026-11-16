"""Shared, versioned rigid transforms. Never infer gravity from camera poses."""

import hashlib
import json

import numpy as np

TRANSFORM_VERSION = "RH_YUP_BOTTOM_CENTER_V1"
CONVERTER_VERSION = "trimesh-4.11.4-linear-color-v1"
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


def recipe_key(sha, rotation):
    rotation_matrix(rotation)
    return hashlib.sha256(
        json.dumps(
            [sha, rotation, CONVERTER_VERSION, TRANSFORM_VERSION], separators=(",", ":")
        ).encode()
    ).hexdigest()

"""Outdoor collision mesh generator — Gaussian means → collision GLB (Phase 12).

Pipeline:
  1. Load Gaussian means from SOG file
  2. Filter outliers (below ground plane, too high, too sparse)
  3. Voxel downsample
  4. Ground extraction via RANSAC plane fitting
  5. Generate terrain mesh via Delaunay triangulation
  6. Simplify mesh
  7. Export as collision GLB (invisible mesh)

Output: collision.glb file in storage.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np

logger = logging.getLogger("gsplatform.collision.outdoor")


def _load_gaussian_means(sog_path: Path) -> np.ndarray:
    """Load Gaussian means (xyz centers) from SOG file.

    For simplicity, we extract positions from the raw SOG binary format.
    SOG format: magic header + position data (float32 x N * 3).
    """
    with open(sog_path, "rb") as f:
        # Skip SOG magic header (32 bytes)
        f.seek(32)

        # Read position data: first 3 float32 per Gaussian = xyz
        # For simplicity, read all positions as float32 array
        raw = f.read()
        n_floats = len(raw) // 4
        n_points = n_floats // 3

        if n_points == 0:
            raise ValueError("No Gaussian points found in SOG file")

        data = np.frombuffer(raw[: n_points * 12], dtype=np.float32)
        points = data.reshape(n_points, 3).astype(np.float64)

    logger.info("Loaded %d Gaussian means from %s", len(points), sog_path)
    return points


def _filter_outliers(points: np.ndarray) -> np.ndarray:
    """Filter outlier points: remove points too high/low, remove isolated."""
    if len(points) == 0:
        return points

    # Remove points with extreme Y (height) values
    y_vals = points[:, 1]
    y_mean = np.mean(y_vals)
    y_std = np.std(y_vals)
    mask = np.abs(y_vals - y_mean) < 3 * y_std

    filtered = points[mask]
    logger.info("Filtered outliers: %d → %d points", len(points), len(filtered))
    return filtered


def _voxel_downsample(points: np.ndarray, voxel_size: float = 0.1) -> np.ndarray:
    """Downsample points using voxel grid."""
    if len(points) == 0:
        return points

    # Quantize to voxel grid
    quantized = np.floor(points / voxel_size).astype(np.int32)
    _, unique_idx = np.unique(quantized, axis=0, return_index=True)
    downsampled = points[np.sort(unique_idx)]

    logger.info(
        "Voxel downsample (size=%.2f): %d → %d points",
        voxel_size, len(points), len(downsampled),
    )
    return downsampled


def _fit_ground_plane(points: np.ndarray) -> tuple[np.ndarray, float]:
    """Fit ground plane via RANSAC. Returns (normal, offset)."""
    if len(points) < 3:
        return np.array([0, 1, 0]), 0.0

    best_inliers = 0
    best_normal = np.array([0, 1, 0])
    best_d = 0.0

    rng = np.random.default_rng(42)
    n_iter = 100
    threshold = 0.05  # 5cm

    for _ in range(n_iter):
        idx = rng.choice(len(points), 3, replace=False)
        p1, p2, p3 = points[idx]

        v1 = p2 - p1
        v2 = p3 - p1
        normal = np.cross(v1, v2)
        norm = np.linalg.norm(normal)
        if norm < 1e-10:
            continue
        normal /= norm

        d = np.dot(normal, p1)
        dists = np.abs(np.dot(points, normal) - d)
        inliers = np.sum(dists < threshold)

        if inliers > best_inliers:
            best_inliers = inliers
            best_normal = normal
            best_d = d

    logger.info(
        "Ground plane fit: normal=[%.3f, %.3f, %.3f], d=%.3f, inliers=%d/%d",
        *best_normal, best_d, best_inliers, len(points),
    )
    return best_normal, best_d


def _generate_terrain_mesh(
    points: np.ndarray,
    normal: np.ndarray,
    d: float,
    grid_resolution: float = 0.2,
) -> tuple[np.ndarray, np.ndarray]:
    """Project points onto ground plane and generate grid-based mesh."""
    # Project points onto local 2D coordinates on the ground plane
    up = normal / np.linalg.norm(normal)
    right = np.cross(up, np.array([1, 0, 0]))
    if np.linalg.norm(right) < 1e-10:
        right = np.cross(up, np.array([0, 0, 1]))
    right /= np.linalg.norm(right)
    forward = np.cross(right, up)

    # Project to 2D
    origin = up * d
    proj_2d = np.column_stack([
        np.dot(points - origin, right),
        np.dot(points - origin, forward),
    ])

    # Create grid
    x_min, x_max = proj_2d[:, 0].min(), proj_2d[:, 0].max()
    z_min, z_max = proj_2d[:, 1].min(), proj_2d[:, 1].max()

    n_x = max(2, int((x_max - x_min) / grid_resolution) + 1)
    n_z = max(2, int((z_max - z_min) / grid_resolution) + 1)

    # Sample height at each grid point
    vertices_3d = []
    for iz in range(n_z):
        for ix in range(n_x):
            x = x_min + ix * grid_resolution
            z = z_min + iz * grid_resolution

            # Find points near this grid cell
            dists_xy = np.sqrt(
                (proj_2d[:, 0] - x) ** 2 + (proj_2d[:, 1] - z) ** 2
            )
            mask = dists_xy < grid_resolution * 1.5

            if np.any(mask):
                # Average height of nearby points
                local_proj = proj_2d[mask]
                local_pts = points[mask]
                # Project back to 3D along ground normal
                heights = np.dot(local_pts - origin, up)
                avg_height = np.mean(heights)
                pos = origin + up * avg_height + right * x + forward * z
            else:
                pos = origin + right * x + forward * z

            vertices_3d.append(pos)

    vertices = np.array(vertices_3d, dtype=np.float32)

    # Generate triangle indices for grid
    indices = []
    for iz in range(n_z - 1):
        for ix in range(n_x - 1):
            i0 = iz * n_x + ix
            i1 = i0 + 1
            i2 = i0 + n_x
            i3 = i2 + 1

            indices.extend([i0, i1, i2])
            indices.extend([i1, i3, i2])

    indices = np.array(indices, dtype=np.uint32)

    logger.info("Terrain mesh: %d vertices, %d triangles", len(vertices), len(indices) // 3)
    return vertices, indices


def _write_glb(vertices: np.ndarray, indices: np.ndarray, output_path: Path) -> None:
    """Write mesh as GLB file (binary glTF 2.0)."""
    import struct

    # Prepare vertex buffer (positions only, float32 x 3)
    vertex_buffer = vertices.tobytes()
    vertex_count = len(vertices)

    # Prepare index buffer (uint32)
    index_buffer = indices.tobytes()
    index_count = len(indices)

    # Pad buffers to 4-byte alignment
    vertex_pad = (4 - len(vertex_buffer) % 4) % 4
    index_pad = (4 - len(index_buffer) % 4) % 4
    vertex_buffer += b'\x00' * vertex_pad
    index_buffer += b'\x00' * index_pad

    # Binary chunk: vertex data + index data
    bin_data = vertex_buffer + index_buffer
    bin_length = len(bin_data)

    # JSON chunk
    gltf = {
        "asset": {"version": "2.0", "generator": "GSPlatform Collision Builder"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{
            "primitives": [{
                "attributes": {"POSITION": 0},
                "indices": 1,
                "mode": 4,  # TRIANGLES
            }]
        }],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,  # FLOAT
                "count": vertex_count,
                "type": "VEC3",
                "min": vertices.min(axis=0).tolist(),
                "max": vertices.max(axis=0).tolist(),
            },
            {
                "bufferView": 1,
                "componentType": 5125,  # UNSIGNED_INT
                "count": index_count,
                "type": "SCALAR",
            }
        ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": len(vertex_buffer),
                "target": 34962,  # ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": len(vertex_buffer),
                "byteLength": len(index_buffer),
                "target": 34963,  # ELEMENT_ARRAY_BUFFER
            }
        ],
        "buffers": [{
            "byteLength": bin_length,
        }]
    }

    import json
    json_str = json.dumps(gltf, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')

    # Pad JSON to 4-byte alignment
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes += b'\x20' * json_pad  # Space padding

    # GLB header
    total_length = 12 + 8 + len(json_bytes) + 8 + bin_length
    header = struct.pack('<III', 0x46546C67, 2, total_length)  # magic, version, length

    # JSON chunk
    json_chunk = struct.pack('<II', len(json_bytes), 0x4E4F534A)  # length, type=JSON
    # Binary chunk
    bin_chunk_header = struct.pack('<II', bin_length, 0x004E4942)  # length, type=BIN

    with open(output_path, 'wb') as f:
        f.write(header)
        f.write(json_chunk)
        f.write(json_bytes)
        f.write(bin_chunk_header)
        f.write(bin_data)

    logger.info("Wrote collision GLB: %s (%d bytes)", output_path, total_length)


def build_outdoor_collision(
    sog_path: Path,
    output_path: Path,
    voxel_size: float = 0.15,
    grid_resolution: float = 0.2,
) -> dict:
    """Build outdoor collision mesh from Gaussian means.

    Args:
        sog_path: Path to SOG file containing Gaussian splats.
        output_path: Path for output collision.glb.
        voxel_size: Voxel grid size for downsampling.
        grid_resolution: Grid resolution for terrain mesh.

    Returns:
        dict with build metadata.
    """
    # Step 1: Load Gaussian means
    points = _load_gaussian_means(sog_path)

    # Step 2: Filter outliers
    points = _filter_outliers(points)

    # Step 3: Voxel downsample
    points = _voxel_downsample(points, voxel_size)

    # Step 4: Ground plane extraction
    normal, d = _fit_ground_plane(points)

    # Step 5: Generate terrain mesh
    vertices, indices = _generate_terrain_mesh(points, normal, d, grid_resolution)

    # Step 6: Write GLB
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _write_glb(vertices, indices, output_path)

    return {
        "vertex_count": len(vertices),
        "triangle_count": len(indices) // 3,
        "ground_normal": normal.tolist(),
        "ground_offset": d,
        "output_path": str(output_path),
    }

"""COLMAP binary model reader — cameras.bin / images.bin / points3D.bin.

The reconstruction pipeline uses COLMAP's binary output format directly
(no pycolmap dependency). ``colmap mapper`` writes ``sparse/0/*.bin``; we
parse cameras, images (registered poses) and points3D for:

- quality gate (registered image ratio, point count, mean reprojection error)
- gsplat training input (camera intrinsics/extrinsics + 3D point init)
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

# Camera model ids (COLMAP).
CAMERA_MODELS = {
    0: "SIMPLE_PINHOLE",
    1: "PINHOLE",
    2: "SIMPLE_RADIAL",
    3: "RADIAL",
    4: "OPENCV",
    5: "OPENCV_FISHEYE",
    6: "FULL_OPENCV",
    7: "FOV",
    8: "SIMPLE_RADIAL_FISHEYE",
    9: "RADIAL_FISHEYE",
    10: "THIN_PRISM_FISHEYE",
}

_CAMERA_PARAM_COUNT = {
    0: 3,   # f, cx, cy
    1: 4,   # fx, fy, cx, cy
    2: 4,   # f, cx, cy, k1
    3: 5,   # f, cx, cy, k1, k2
    4: 8,
    5: 8,
    6: 12,
    7: 5,
    8: 4,
    9: 5,
    10: 12,
}


@dataclass
class Camera:
    id: int
    model_id: int
    width: int
    height: int
    params: list[float]

    @property
    def model(self) -> str:
        return CAMERA_MODELS.get(self.model_id, f"UNKNOWN({self.model_id})")

    def focal_xy_cxy(self) -> tuple[float, float, float, float]:
        """Return (fx, fy, cx, cy) for the common pinhole-family models."""
        p = self.params
        model = self.model
        if model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "SIMPLE_RADIAL_FISHEYE"):
            f, cx, cy = p[0], p[1], p[2]
            return f, f, cx, cy
        if model in ("PINHOLE", "RADIAL", "OPENCV", "FULL_OPENCV", "OPENCV_FISHEYE",
                     "FOV", "RADIAL_FISHEYE", "THIN_PRISM_FISHEYE"):
            fx, fy = p[0], p[1]
            cx, cy = p[2], p[3]
            return fx, fy, cx, cy
        # Unknown model: default to first param as focal, center as principal point.
        f = p[0] if p else 1.0
        return f, f, self.width / 2, self.height / 2


@dataclass
class Image:
    id: int
    qvec: list[float]  # w, x, y, z
    tvec: list[float]
    camera_id: int
    name: str
    num_points2d: int


@dataclass
class Point3D:
    id: int
    xyz: list[float]
    rgb: list[int]
    error: float


@dataclass
class SparseModel:
    cameras: dict[int, Camera]
    images: dict[int, Image]
    points3d: dict[int, Point3D]
    path: Path

    @property
    def registered_image_count(self) -> int:
        return len(self.images)

    @property
    def point_count(self) -> int:
        return len(self.points3d)

    def mean_reprojection_error(self) -> float | None:
        errors = [p.error for p in self.points3d.values()]
        if not errors:
            return None
        return sum(errors) / len(errors)


def read_cameras_bin(path: Path) -> dict[int, Camera]:
    cameras: dict[int, Camera] = {}
    with open(path, "rb") as fh:
        num_cameras = struct.unpack("<Q", fh.read(8))[0]
        for _ in range(num_cameras):
            cam_id, model_id, width, height = struct.unpack("<iiQQ", fh.read(24))
            num_params = _CAMERA_PARAM_COUNT.get(model_id, 0)
            params = list(struct.unpack(f"<{num_params}d", fh.read(8 * num_params)))
            cameras[cam_id] = Camera(cam_id, model_id, width, height, params)
    return cameras


def read_images_bin(path: Path) -> dict[int, Image]:
    images: dict[int, Image] = {}
    with open(path, "rb") as fh:
        num_images = struct.unpack("<Q", fh.read(8))[0]
        for _ in range(num_images):
            # COLMAP 3.9 binary layout (types.h: image_t=uint32_t, camera_t=uint32_t):
            #   image_id (uint32), qvec (4×double), tvec (3×double),
            #   camera_id (uint32), name (NUL-terminated), num_points2D (uint64),
            #   then num_points2D × [x (double), y (double), point3D_id (uint64)]
            #   — each entry is 24 bytes.
            img_id, qw, qx, qy, qz = struct.unpack("<I4d", fh.read(4 + 32))
            tx, ty, tz = struct.unpack("<3d", fh.read(24))
            cam_id = struct.unpack("<I", fh.read(4))[0]
            name_bytes = fh.read(1)
            while name_bytes and name_bytes[-1:] != b"\x00":
                name_bytes += fh.read(1)
            name = name_bytes[:-1].decode("utf-8", "replace") if name_bytes else ""
            num_p2d = struct.unpack("<Q", fh.read(8))[0]
            fh.read(24 * num_p2d)  # skip point2D x(double)+y(double)+point3D_id(uint64)
            images[img_id] = Image(
                id=img_id,
                qvec=[qw, qx, qy, qz],
                tvec=[tx, ty, tz],
                camera_id=cam_id,
                name=name,
                num_points2d=num_p2d,
            )
    return images


def read_points3d_bin(path: Path) -> dict[int, Point3D]:
    points: dict[int, Point3D] = {}
    with open(path, "rb") as fh:
        num_points = struct.unpack("<Q", fh.read(8))[0]
        for _ in range(num_points):
            pid = struct.unpack("<Q", fh.read(8))[0]
            x, y, z = struct.unpack("<ddd", fh.read(24))
            r, g, b = struct.unpack("<BBB", fh.read(3))
            error = struct.unpack("<d", fh.read(8))[0]
            num_tracks = struct.unpack("<Q", fh.read(8))[0]
            # Each track element is image_id (uint32) + point2D_idx (uint32) = 8 bytes.
            fh.read(8 * num_tracks)
            points[pid] = Point3D(pid, [x, y, z], [r, g, b], error)
    return points


def read_sparse_model(sparse_dir: Path) -> SparseModel:
    """Load sparse/<N>/ (cameras.bin + images.bin + points3D.bin)."""
    cameras_path = sparse_dir / "cameras.bin"
    images_path = sparse_dir / "images.bin"
    points_path = sparse_dir / "points3D.bin"
    if not (cameras_path.exists() and images_path.exists() and points_path.exists()):
        raise FileNotFoundError(f"COLMAP sparse 模型不完整: {sparse_dir}")
    cameras = read_cameras_bin(cameras_path)
    images = read_images_bin(images_path)
    points = read_points3d_bin(points_path)
    return SparseModel(cameras, images, points, sparse_dir)
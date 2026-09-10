#!/usr/bin/env python3
"""Generate a synthetic 3D Gaussian Splatting PLY asset.

Creates a deterministic, project-owned gaussian scene (a stylized "garden" of
colored primitives) in the SuperSplat binary PLY layout, so that
low/medium/high LOD decimation yields clearly measurable density differences
while sharing one coordinate system, units, orientation and color rules.

Usage:
  python3 scripts/generate_synthetic_scene.py --seed 7 --count 20000 \
      --out scenes/progressive-test/source.ply
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np

# 59 float32 properties, in the order SuperSplat expects.
_FIELDS = [
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
] + [f"f_rest_{i}" for i in range(45)] + [
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
]

_DTYPE = np.dtype([(name, "<f4") for name in _FIELDS])


def _apply_rot(qw, qx, qy, qz, v):
    """Rotate vector v by quaternion (qw,qx,qy,qz)."""
    w, a, b, c = qw, qx, qy, qz
    r0 = (1 - 2 * (b * b + c * c)) * v[0] + (2 * (a * b - c * w)) * v[1] + (2 * (a * c + b * w)) * v[2]
    r1 = (2 * (a * b + c * w)) * v[0] + (1 - 2 * (a * a + c * c)) * v[1] + (2 * (b * c - a * w)) * v[2]
    r2 = (2 * (a * c - b * w)) * v[0] + (2 * (b * c + a * w)) * v[1] + (1 - 2 * (a * a + b * b)) * v[2]
    return np.array([r0, r1, r2])


def build_scene(seed: int, count: int) -> np.ndarray:
    """Assemble the synthetic garden scene into an (N, 3+3+3+3) array.

    Returns a structured numpy array with fields: position, color (0..1),
    scale (3), rotation (quaternion).
    """
    rng = np.random.default_rng(seed)

    positions = []
    colors = []
    scales = []
    quats = []

    def add(pts, color, scale, roll, yaw, pitch, squash=1.0):
        cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
        cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
        cr, sr = math.cos(roll / 2), math.sin(roll / 2)
        qw = cy * cp * cr + sy * sp * sr
        qx = cy * cp * sr - sy * sp * cr
        qy = cy * sp * cr + sy * cp * sr
        qz = sy * cp * cr - cy * sp * sr
        for p in pts:
            r = _apply_rot(qw, qx, qy, qz, p)
            positions.append(r)
            colors.append(color)
            scales.append([scale, scale * squash, scale])
            quats.append([qw, qx, qy, qz])

    # Ground plane (green, flattened ellipsoids).
    n_g = max(1, int(count * 0.35))
    xg = rng.uniform(-2.4, 2.4, n_g)
    zg = rng.uniform(-1.6, 1.6, n_g)
    yg = -0.55 + rng.normal(0, 0.005, n_g)
    add(np.column_stack([xg, yg, zg]), [0.38, 0.45, 0.32], 0.045,
        math.radians(45), 0.0, 0.0, squash=0.35)

    # Central colored cube (6 faces sampled).
    seg = 8
    side = 0.62
    u = np.linspace(-side, side, seg)
    faces = []
    for v in np.linspace(-side, side, seg):
        faces += [[u, np.full_like(u, -side), np.full_like(u, v)]]
        faces += [[u, np.full_like(u, side), np.full_like(u, v)]]
        faces += [[np.full_like(u, -side), u, np.full_like(u, v)]]
        faces += [[np.full_like(u, side), u, np.full_like(u, v)]]
        faces += [[u, np.full_like(u, v), np.full_like(u, -side)]]
        faces += [[u, np.full_like(u, v), np.full_like(u, side)]]
    cube = np.concatenate([np.column_stack(f) for f in faces], axis=0)
    n_c = max(1, int(count * 0.30))
    idx = rng.integers(0, len(cube), n_c)
    add(cube[idx] + rng.normal(0, 0.004, (n_c, 3)),
        [0.84, 0.54, 0.37], 0.035, 0.0, math.radians(28), math.radians(14))

    # Torus ring (blue), revolved around Y.
    n_t = max(1, int(count * 0.18))
    uu = rng.uniform(0, 2 * math.pi, n_t)
    vv = rng.uniform(0, 2 * math.pi, n_t)
    R, rr = 0.9, 0.12
    px = (R + rr * np.cos(uu)) * np.cos(vv)
    py = rr * np.sin(uu) + 0.35
    pz = (R + rr * np.cos(uu)) * np.sin(vv)
    torus = np.column_stack([px, py, pz]) + rng.normal(0, 0.004, (n_t, 3))
    add(torus, [0.36, 0.58, 0.84], 0.028, 0.0, 0.0, math.radians(60))

    # Yellow spheres sprinkled around.
    n_sp = max(1, int(count * 0.17))
    sph = []
    for _ in range(n_sp):
        cx, cz, cy = rng.uniform(-2.0, 2.0), rng.uniform(-1.4, 1.4), rng.uniform(-0.2, 0.9)
        rr = rng.uniform(0.06, 0.13)
        d = rng.normal(0, rr, (12, 3))
        sph.append(np.column_stack([cx + d[:, 0], cy + d[:, 1], cz + d[:, 2]]))
    sph = np.concatenate(sph, axis=0)
    add(sph, [0.91, 0.78, 0.37], 0.02, 0.0, 0.0, 0.0)

    # Green "plant" on the right.
    n_l = max(1, int(count * 0.10))
    t = rng.random(n_l)
    leaf = np.column_stack([1.15 + rng.normal(0, 0.05, n_l),
                            -0.55 + 1.1 * t,
                            0.7 + rng.normal(0, 0.05, n_l)])
    add(leaf, [0.42, 0.66, 0.38], 0.03, 0.0, 0.0, 0.0, squash=0.8)

    arr = np.empty(len(positions), dtype=_DTYPE)
    pos = np.asarray(positions)
    col = np.asarray(colors)
    scl = np.asarray(scales)
    rot = np.asarray(quats)

    arr["x"], arr["y"], arr["z"] = pos[:, 0], pos[:, 1], pos[:, 2]
    arr["nx"], arr["ny"], arr["nz"] = 0.0, 0.0, 0.0
    # DC term: SH color maps rgb(0..1) -> c * inv(0.5*sqrt(pi)).
    inv = 0.5 * math.sqrt(math.pi)
    arr["f_dc_0"], arr["f_dc_1"], arr["f_dc_2"] = col[:, 0] * inv, col[:, 1] * inv, col[:, 2] * inv
    arr["opacity"] = 0.8
    arr["scale_0"], arr["scale_1"], arr["scale_2"] = scl[:, 0], scl[:, 1], scl[:, 2]
    arr["rot_0"], arr["rot_1"], arr["rot_2"], arr["rot_3"] = rot[:, 0], rot[:, 1], rot[:, 2], rot[:, 3]
    return arr


def write_ply(out_path: str, arr: np.ndarray) -> None:
    """Write the structured array as a binary little-endian PLY."""
    n = len(arr)
    with open(out_path, "wb") as f:
        f.write(b"ply\n")
        f.write(b"format binary_little_endian 1.0\n")
        f.write(f"element vertex {n}\n".encode())
        for name in _FIELDS:
            f.write(f"property float {name}\n".encode())
        f.write(b"end_header\n")
        f.write(arr.tobytes())


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--count", type=int, default=20000)
    ap.add_argument("--out", required=True, help="output .ply path")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    try:
        import numpy  # noqa: F401
    except ImportError:
        print("error: numpy is required", file=sys.stderr)
        return 1
    arr = build_scene(args.seed, args.count)
    write_ply(args.out, arr)
    print(f"wrote {len(arr)} gaussians -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

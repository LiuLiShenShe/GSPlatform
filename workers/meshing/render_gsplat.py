"""Render calibrated-camera depth observations for NKSR, never Gaussian centers."""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from gsplat import rasterization

from workers.reconstruction.colmap_reader import read_sparse_model
from workers.reconstruction.masked_training import aligned_target
from workers.reconstruction.train_gsplat_script import (
    _latest_checkpoint,
    build_camera_data,
)


def depth_observations(depth, rgb, valid, intrinsic, viewmat):
    """Depth finite differences, with normals facing their observing camera."""
    height, width = depth.shape
    y, x = np.mgrid[:height, :width]
    rays = np.stack(
        (
            (x - intrinsic[0, 2]) / intrinsic[0, 0],
            (y - intrinsic[1, 2]) / intrinsic[1, 1],
            np.ones_like(x),
        ),
        -1,
    )
    camera = rays * depth[..., None]
    inverse = np.linalg.inv(viewmat)
    world = camera @ inverse[:3, :3].T + inverse[:3, 3]
    normals = np.cross(
        world[1:-1, 2:] - world[1:-1, :-2], world[2:, 1:-1] - world[:-2, 1:-1]
    )
    norm = np.linalg.norm(normals, axis=-1)
    center_depth = depth[1:-1, 1:-1]
    good = valid[1:-1, 1:-1].copy()
    for neighbor_valid, neighbor_depth in (
        (valid[1:-1, 2:], depth[1:-1, 2:]),
        (valid[1:-1, :-2], depth[1:-1, :-2]),
        (valid[2:, 1:-1], depth[2:, 1:-1]),
        (valid[:-2, 1:-1], depth[:-2, 1:-1]),
    ):
        # Do not bridge silhouettes or depth discontinuities with false normals.
        good &= neighbor_valid & (
            np.abs(neighbor_depth - center_depth) < 0.05 * center_depth
        )
    good &= np.isfinite(norm) & (norm > 1e-10)
    xyz = world[1:-1, 1:-1][good]
    normal = normals[good] / norm[good, None]
    sensor = np.broadcast_to(inverse[:3, 3], xyz.shape).copy()
    normal[np.sum(normal * (sensor - xyz), axis=1) < 0] *= -1
    return xyz, normal, rgb[1:-1, 1:-1][good], sensor


@torch.no_grad()
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.source
    settings = json.loads((root / "gsplat/params.json").read_text())
    checkpoint = _latest_checkpoint(root / "gsplat/checkpoints")
    if checkpoint is None:
        raise ValueError("缺少最终 3DGS 检查点")
    # Only platform-owned training artifacts are loaded, never request paths.
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    # The existing trainer numbers steps from zero (30,000 steps ends at 29,999).
    if int(saved["step"]) + 1 != int(settings["iterations"]):
        raise ValueError("最终 3DGS 检查点迭代数不匹配")
    params = {k: v.cuda() for k, v in saved["params"].items()}
    model = read_sparse_model(root / "colmap/sparse/0")
    # Keep per-view work bounded; identical camera distortion/mask alignment as training.
    largest = max(max(c.width, c.height) for c in model.cameras.values())
    downscale = max(int(settings.get("downscale", 1)), int(np.ceil(largest / 1280)))
    views, frames = build_camera_data(
        model, root / "frames", downscale, torch.device("cuda"), torch.float32
    )
    parts = []
    rng = np.random.default_rng(42)
    per_view = max(500, 200000 // max(1, len(views)))
    for index, (view, image) in enumerate(zip(views, frames, strict=True)):
        if image is None:
            raise ValueError("原重建照片不可用")
        mask = root / "segmentation/masks" / (view["name"] + ".png")
        target, foreground, valid, intrinsic = aligned_target(
            image, view["camera"], downscale, mask if mask.is_file() else None
        )
        height, width = target.shape[:2]
        rendered, alpha, _ = rasterization(
            means=params["means"],
            quats=params["quats"],
            scales=params["scales"].exp(),
            opacities=params["opacities"].sigmoid(),
            colors=torch.cat((params["sh0"], params["shN"]), dim=1),
            sh_degree=int(settings.get("sh_degree", 0)),
            viewmats=view["viewmat"][None],
            Ks=intrinsic.cuda()[None],
            width=width,
            height=height,
            packed=False,
            render_mode="RGB+ED",
        )
        array = rendered[0].cpu().numpy()
        depth, rgb = array[..., 3], np.clip(array[..., :3], 0, 1)
        good = (alpha[0, ..., 0].cpu().numpy() >= 0.5) & (valid[..., 0].numpy() > 0.5)
        good &= np.isfinite(depth) & (depth > 0)
        if foreground is not None:
            good &= foreground[..., 0].numpy() > 0.5
        observed = depth_observations(
            depth, rgb, good, intrinsic.numpy(), view["viewmat"].cpu().numpy()
        )
        if len(observed[0]):
            indices = rng.choice(
                len(observed[0]), min(per_view, len(observed[0])), replace=False
            )
            parts.append(tuple(value[indices].astype(np.float32) for value in observed))
        print(
            f"MESHPROGRESS RENDERING {5 + int(40 * (index + 1) / len(views))}",
            flush=True,
        )
    if not parts or sum(len(p[0]) for p in parts) < 100:
        raise ValueError("可用深度表面不足，无法生成可靠网格")
    joined = [np.concatenate([p[i] for p in parts]) for i in range(4)]
    indices = rng.choice(len(joined[0]), min(150000, len(joined[0])), replace=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        args.output,
        **dict(
            zip(
                ("xyz", "normal", "rgb", "sensor"),
                [p[indices] for p in joined],
                strict=True,
            )
        ),
    )


if __name__ == "__main__":
    main()

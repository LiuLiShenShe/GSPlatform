"""Aligned pinhole training targets and foreground supervision for existing gsplat."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.nn import functional


def aligned_target(path: Path, camera, downscale: int, mask_path: Path | None = None):
    """Undistort RGB and mask through the SAME COLMAP projection, then downscale.

    A pinhole rasterizer cannot compare against radially distorted source pixels.
    Backward mapping samples the original image at the distorted projection of
    each output pinhole pixel; no external calibration or guessed intrinsics.
    """
    with Image.open(path) as image:
        if image.size != (camera.width, camera.height):
            raise ValueError(f"COLMAP/RGB dimensions disagree: {path.name}")
        rgb = torch.from_numpy(
            np.asarray(image.convert("RGB"), dtype=np.float32).copy() / 255
        )
    mask = None
    if mask_path:
        with Image.open(mask_path) as image:
            if image.size != (camera.width, camera.height):
                raise ValueError(f"COLMAP/mask dimensions disagree: {path.name}")
            mask = torch.from_numpy((np.asarray(image) > 0).astype(np.float32).copy())[
                ..., None
            ]
    height, width = (
        max(1, camera.height // downscale),
        max(1, camera.width // downscale),
    )
    fx, fy, cx, cy = camera.focal_xy_cxy()
    sx, sy = width / camera.width, height / camera.height
    intrinsic = torch.tensor(
        [[fx * sx, 0, cx * sx], [0, fy * sy, cy * sy], [0, 0, 1]], dtype=torch.float32
    )
    v, u = torch.meshgrid(torch.arange(height), torch.arange(width), indexing="ij")
    x, y = (u / sx - cx) / fx, (v / sy - cy) / fy
    r2 = x * x + y * y
    model, params = camera.model, camera.params
    if model in {"SIMPLE_PINHOLE", "PINHOLE"}:
        xd, yd = x, y
    elif model in {"SIMPLE_RADIAL", "RADIAL"}:
        k1 = params[3]
        k2 = params[4] if model == "RADIAL" else 0
        radial = 1 + k1 * r2 + k2 * r2 * r2
        xd, yd = x * radial, y * radial
    elif model == "OPENCV":
        k1, k2, p1, p2 = params[4:8]
        radial = 1 + k1 * r2 + k2 * r2 * r2
        xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    else:
        raise ValueError(f"Unsupported training distortion model: {model}")
    px, py = xd * fx + cx, yd * fy + cy
    grid = torch.stack(
        ((px + 0.5) * 2 / camera.width - 1, (py + 0.5) * 2 / camera.height - 1), dim=-1
    )[None]
    valid = (
        (px >= 0) & (px <= camera.width - 1) & (py >= 0) & (py <= camera.height - 1)
    )[..., None].float()

    def sample(tensor, mode):
        result = functional.grid_sample(
            tensor.permute(2, 0, 1)[None],
            grid,
            mode=mode,
            padding_mode="zeros",
            align_corners=False,
        )
        return result[0].permute(1, 2, 0)

    return (
        sample(rgb, "bilinear"),
        sample(mask, "nearest") if mask is not None else None,
        valid,
        intrinsic,
    )


def foreground_loss(rendered, alpha, target, mask, valid):
    """Normalized foreground RGB and alpha losses; background RGB never supervises."""
    foreground = mask * valid
    background = (1 - mask) * valid
    rgb = ((rendered - target).abs() * foreground).sum() / (
        foreground.sum() * 3
    ).clamp_min(1)
    foreground_alpha = (
        (1 - alpha).abs() * foreground
    ).sum() / foreground.sum().clamp_min(1)
    background_alpha = (alpha.abs() * background).sum() / background.sum().clamp_min(1)
    return rgb + 0.2 * foreground_alpha + 0.2 * background_alpha, {
        "foregroundRgbLoss": rgb.detach(),
        "foregroundAlphaLoss": foreground_alpha.detach(),
        "backgroundAlphaLoss": background_alpha.detach(),
    }


def multiview_foreground_points(xyz, views, masks, *, minimum_support: int = 2):
    """Keep points supported by at least two masks and most visible projections."""
    points = torch.as_tensor(xyz, dtype=torch.float32)
    visible = torch.zeros(len(points), dtype=torch.int32)
    support = torch.zeros_like(visible)
    for view, mask in zip(views, masks, strict=True):
        matrix = view["viewmat"].detach().cpu()
        local = points @ matrix[:3, :3].T + matrix[:3, 3]
        intrinsic = view["K"].detach().cpu()
        projected = local @ intrinsic.T
        pixels = projected[:, :2] / projected[:, 2:].clamp_min(1e-8)
        x, y = pixels[:, 0].round().long(), pixels[:, 1].round().long()
        height, width = mask.shape[:2]
        good = (local[:, 2] > 0) & (x >= 0) & (x < width) & (y >= 0) & (y < height)
        visible += good
        indices = good.nonzero().flatten()
        support[indices] += (mask[y[indices], x[indices], 0] > 0.5).int()
    return ((support >= minimum_support) & (support.float() >= visible * 0.6)).numpy()

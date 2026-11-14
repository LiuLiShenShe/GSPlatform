"""Adapter for the operator's existing 2D Gaussian Splatting trainer.

The native surfel rasterizer/training loop and foreground losses are reused
without changing its source tree. Preserve its two-scale PLY; the shared
SOG/Editor renderer receives a thin, finite third scale for compatibility.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from plyfile import PlyData, PlyElement

from workers.reconstruction.backends import backend_identity, surfel_runtime
from workers.reconstruction.colmap_reader import read_sparse_model
from workers.reconstruction.masked_training import (
    aligned_target,
    multiview_foreground_points,
)
from workers.reconstruction.segmentation import validate_manifest


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("colmap-dir", "images-dir", "output", "checkpoint-dir"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=30000)
    parser.add_argument("--sh-degree", type=int, default=2)
    parser.add_argument("--lr", type=float, default=0.00016)
    parser.add_argument("--save-interval", type=int, default=500)
    parser.add_argument("--downscale", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--min-splats", type=int, default=100)
    parser.add_argument("--masks-dir", type=Path)
    parser.add_argument("--segmentation-manifest", type=Path)
    parser.add_argument("--random-init", action="store_true")
    parser.add_argument("--no-densify", action="store_true")
    return parser.parse_args(argv)


def _rotation(qvec):
    w, x, y, z = np.asarray(qvec) / np.linalg.norm(qvec)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float32,
    )


def prepare_dataset(args, destination: Path) -> dict:
    """Write centered, undistorted PINHOLE views and aligned SAM3 masks."""
    if args.downscale < 1:
        raise ValueError("downscale must be positive")
    if bool(args.masks_dir) != bool(args.segmentation_manifest):
        raise ValueError("mask directory and manifest are required together")
    if args.masks_dir:
        validate_manifest(args.segmentation_manifest.parent, args.images_dir)
    model = read_sparse_model(args.colmap_dir)
    for folder in ("images", "masks", "sparse/0"):
        (destination / folder).mkdir(parents=True, exist_ok=True)
    camera_lines, image_lines, views, masks = [], [], [], []
    for image in model.images.values():
        camera = model.cameras[image.camera_id]
        path = args.images_dir / image.name
        if not path.is_file():
            raise FileNotFoundError(f"COLMAP source image missing: {image.name}")
        mask_path = args.masks_dir / (image.name + ".png") if args.masks_dir else None
        rgb, mask, valid, intrinsic = aligned_target(
            path, camera, args.downscale, mask_path, center_principal_point=True
        )
        height, width = rgb.shape[:2]
        name = f"view_{image.id:08d}.png"
        Image.fromarray((rgb.clamp(0, 1).numpy() * 255).round().astype(np.uint8)).save(
            destination / "images" / name
        )
        if mask is not None:
            mask = mask * valid
            Image.fromarray((mask[..., 0].numpy() * 255).astype(np.uint8)).save(
                destination / "masks" / name
            )
            masks.append(mask)
        fx, fy, cx, cy = (
            float(intrinsic[0, 0]),
            float(intrinsic[1, 1]),
            float(intrinsic[0, 2]),
            float(intrinsic[1, 2]),
        )
        camera_lines.append(
            f"{image.id} PINHOLE {width} {height} {fx} {fy} {cx} {cy}\n"
        )
        pose = " ".join(str(v) for v in [*image.qvec, *image.tvec])
        image_lines.append(f"{image.id} {pose} {image.id} {name}\n\n")
        matrix = torch.eye(4)
        matrix[:3, :3] = torch.from_numpy(_rotation(image.qvec))
        matrix[:3, 3] = torch.tensor(image.tvec)
        views.append({"viewmat": matrix, "K": intrinsic})
    if len(views) < 3 or (args.masks_dir and sum(bool(m.sum()) for m in masks) < 3):
        raise ValueError("2DGS needs at least three usable registered target views")
    points = list(model.points3d.values())
    xyz = np.asarray([p.xyz for p in points], dtype=np.float32).reshape(-1, 3)
    rgb = np.asarray([p.rgb for p in points], dtype=np.uint8).reshape(-1, 3)
    if args.masks_dir:
        keep = multiview_foreground_points(xyz, views, masks)
        xyz, rgb = xyz[keep], rgb[keep]
    if len(xyz) < args.min_splats:
        raise ValueError(
            f"2DGS only has {len(xyz)} supported points; need {args.min_splats}"
        )
    cloud = np.zeros(
        len(xyz),
        dtype=[
            ("x", "f4"),
            ("y", "f4"),
            ("z", "f4"),
            ("nx", "f4"),
            ("ny", "f4"),
            ("nz", "f4"),
            ("red", "u1"),
            ("green", "u1"),
            ("blue", "u1"),
        ],
    )
    for index, key in enumerate(("x", "y", "z")):
        cloud[key] = xyz[:, index]
    for index, key in enumerate(("red", "green", "blue")):
        cloud[key] = rgb[:, index]
    sparse = destination / "sparse/0"
    (sparse / "cameras.txt").write_text("".join(camera_lines))
    (sparse / "images.txt").write_text("".join(image_lines))
    PlyData([PlyElement.describe(cloud, "vertex")]).write(sparse / "points3D.ply")
    return {
        "registeredViews": len(views),
        "initialColmapPoints": len(points),
        "targetInitialPoints": len(xyz),
        "masked": bool(args.masks_dir),
    }


def export_editor_ply(source: Path, output: Path) -> int:
    """Embed native XY surfels as thin ellipsoids; retain world coordinates."""
    data = PlyData.read(source)
    vertices = data["vertex"].data
    names = vertices.dtype.names or ()
    required = {
        "x",
        "y",
        "z",
        "scale_0",
        "scale_1",
        "opacity",
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    }
    if not required.issubset(names) or "scale_2" in names:
        raise ValueError("Expected a native two-scale 2DGS PLY")
    if any(not np.isfinite(vertices[key]).all() for key in names):
        raise ValueError("2DGS output contains non-finite values")
    adapted = np.empty(len(vertices), dtype=vertices.dtype.descr + [("scale_2", "<f4")])
    for key in names:
        adapted[key] = vertices[key]
    # PLY stores log-scales. Thickness is 1/1000 of the smaller tangent scale,
    # bounded away from zero for SOG quantization; no rescaling of positions.
    adapted["scale_2"] = np.maximum(
        np.minimum(vertices["scale_0"], vertices["scale_1"]) - np.log(1000), -30
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.ply")
    PlyData([PlyElement.describe(adapted, "vertex")]).write(temporary)
    os.replace(temporary, output)
    return len(vertices)


def latest_checkpoint(directory: Path) -> Path | None:
    candidates = [
        p
        for p in directory.glob("chkpnt*.pth")
        if re.fullmatch(r"chkpnt[0-9]+\.pth", p.name)
    ]
    return max(candidates, key=lambda p: int(p.stem[6:]), default=None)


def main(argv=None) -> int:
    args = parse_args(argv)
    started = time.monotonic()
    try:
        if args.iterations < 1 or args.random_init:
            raise ValueError(
                "2DGS requires positive iterations and COLMAP point initialization"
            )
        if not torch.cuda.is_available() or torch.device(args.device).type != "cuda":
            raise ValueError("2DGS requires CUDA")
        torch.cuda.set_device(torch.device(args.device))
        torch.set_num_threads(min(torch.get_num_threads(), 4))
        torch.manual_seed(args.seed)
        random.seed(args.seed)
        np.random.seed(args.seed)
        repo, _ = surfel_runtime()
        identity = backend_identity("2dgs")
        root = args.checkpoint_dir / "2dgs"
        root.mkdir(parents=True, exist_ok=True)
        dataset = root / "dataset"
        print("TRAINING_BACKEND algorithm=2dgs", flush=True)
        statistics = prepare_dataset(args, dataset)
        print(
            f"2DGS_INPUT views={statistics['registeredViews']} "
            f"points={statistics['targetInitialPoints']} masked={statistics['masked']}",
            flush=True,
        )
        sys.path.insert(0, str(repo))
        spec = importlib.util.spec_from_file_location(
            "platform_2dgs_backend", repo / "train.py"
        )
        backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(backend)
        parser = argparse.ArgumentParser()
        model_group = backend.ModelParams(parser)
        optim_group = backend.OptimizationParams(parser)
        pipeline_group = backend.PipelineParams(parser)
        native = parser.parse_args([])
        if args.masks_dir and not all(
            hasattr(native, name)
            for name in (
                "mask_mode",
                "mask_dir",
                "mask_pattern",
                "use_foreground_rgb_loss",
                "use_mask_loss",
                "use_bg_opacity_loss",
                "lambda_mask",
                "lambda_bg",
            )
        ):
            raise ValueError("配置的 2DGS 训练器缺少提示词掩膜监督支持")
        native.source_path, native.model_path = str(dataset), str(root)
        native.sh_degree, native.resolution = args.sh_degree, 1
        native.iterations = native.position_lr_max_steps = args.iterations
        native.position_lr_init, native.position_lr_final = args.lr, args.lr * 0.01
        native.data_device = "cpu"
        if args.no_densify:
            native.densify_until_iter = 0
        if args.masks_dir:
            native.mask_mode, native.mask_dir = "alpha", str(dataset / "masks")
            native.mask_pattern = "{stem}.png"
            native.use_foreground_rgb_loss = native.use_mask_loss = True
            native.use_bg_opacity_loss = True
            native.lambda_mask = native.lambda_bg = 0.2
        report = backend.training_report

        def progress(writer, iteration, ll1, loss, *rest):
            statistics["completedIterations"] = iteration
            statistics["finalLoss"] = float(loss.detach())
            if iteration % 10 == 0 or iteration == args.iterations:
                print(
                    f"GSITER step={iteration} total={args.iterations} loss={float(loss):.6f}",
                    flush=True,
                )
            return report(writer, iteration, ll1, loss, *rest)

        backend.training_report = progress
        # Native checkpoints remain resumable but become atomic on this host.
        save = torch.save

        def atomic_save(value, file, *positional, **keywords):
            if isinstance(file, (str, Path)) and re.fullmatch(
                r"chkpnt[0-9]+\.pth", Path(file).name
            ):
                temporary = Path(str(file) + ".tmp")
                save(value, temporary, *positional, **keywords)
                os.replace(temporary, file)
            else:
                save(value, file, *positional, **keywords)

        torch.save = atomic_save
        checkpoints = (
            list(range(args.save_interval, args.iterations, args.save_interval))
            if args.save_interval > 0
            else []
        )
        checkpoints.append(args.iterations)
        checkpoint = latest_checkpoint(root)
        # The platform viewer owns interaction; no training GUI socket is opened.
        backend.network_gui.try_connect = lambda *_: None
        try:
            backend.training(
                model_group.extract(native),
                optim_group.extract(native),
                pipeline_group.extract(native),
                [],
                [args.iterations],
                checkpoints,
                str(checkpoint) if checkpoint else None,
            )
        finally:
            torch.save = save
        source = root / f"point_cloud/iteration_{args.iterations}/point_cloud.ply"
        count = export_editor_ply(source, args.output)
        if count < args.min_splats:
            raise ValueError(f"2DGS output only has {count} surfels")
        statistics.update(
            algorithm="2dgs",
            backend=identity,
            iterations=args.iterations,
            completedIterations=args.iterations,
            shDegree=args.sh_degree,
            outputGaussians=count,
            seconds=time.monotonic() - started,
            nativePly=str(source),
            editorExport="thin-ellipsoid-1e-3",
            lambdaNormal=native.lambda_normal,
            lambdaDist=native.lambda_dist,
        )
        (args.output.parent / "training-stats.json").write_text(
            json.dumps(statistics, indent=2)
        )
        print(f"TRAINING_DONE algorithm=2dgs splats={count}", flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - subprocess boundary reports native trainer failures
        import traceback

        print(
            f"ERROR 2DGS_FAILED: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

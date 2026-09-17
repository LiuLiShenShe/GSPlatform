"""Standalone gsplat trainer — COLMAP sparse model -> trained 3D Gaussians (Phase 07 TRAINING).

Invoked as ``python -m workers.reconstruction.train_gsplat_script`` by the
reconstruction pipeline's :class:`CommandRunner` (allow-listed ``python``).
Reads a COLMAP sparse model (``cameras.bin`` / ``images.bin`` / ``points3D.bin``)
plus the extracted image frames, initializes 3D Gaussians from the COLMAP points,
and runs the gsplat :func:`DefaultStrategy` densification loop.

Machine-readable protocol (parsed by the orchestrator's progress parser):

- :log:`GSITER step=<N> total=<T> loss=<X>` — real training progress, every 10 iters.
- :log:`TRAINING_DONE splats=<N> loss=<X>` — successful completion, final value.
- ``GPU_OOM`` on stderr + exit 1 — CUDA out-of-memory was caught cleanly.

Single-threaded by design; no multiprocessing, no shared state. Checkpoints are
written atomically (``tmp`` + ``os.replace``) so a kill mid-save never corrupts
the resume checkpoint; ``--cancel-file`` gives the orchestrator a soft-stop path.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch

from gsplat import DefaultStrategy, export_splats, rasterization
from gsplat.utils import normalized_quat_to_rotmat

from workers.reconstruction.colmap_reader import read_sparse_model


# --------------------------------------------------------------------------- #
# Gaussian initialization
# --------------------------------------------------------------------------- #
def _init_from_points(
    model, device: torch.device, dtype: torch.dtype, rng: np.random.Generator
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, float]:
    """Initialize the Gaussian parameters from the COLMAP point cloud.

    Returns (means, scales, quats, opacities, sh0, shN, scene_scale) as CPU
    tensors; ``sh_degree==0`` gives ``shN`` shape ``[N, 0, 3]`` (empty,
    skipped by the rasterizer).
    """
    points = list(model.points3d.values())

    if points:
        xyz = np.asarray([p.xyz for p in points], dtype=np.float64)
        rgb = np.asarray([p.rgb for p in points], dtype=np.float64)  # uint8 in [0,255]
        means = torch.tensor(xyz, dtype=dtype, device=device)
        colors = torch.tensor(rgb / 255.0, dtype=dtype, device=device).clip(0.0, 1.0)
        # Scene scale: robust estimate of the point extents (matches how the
        # densification thresholds in DefaultStrategy are normalized).
        lo = torch.quantile(means, 0.01, dim=0)
        hi = torch.quantile(means, 0.99, dim=0)
        scene_scale = float(torch.norm(hi - lo).clamp_min(1e-6))
    else:
        # No registered points: scatter Gaussians around the camera track.
        if not model.images:
            raise ValueError("COLMAP 模型没有任何已注册相机，无法初始化高斯")
        centers = np.asarray(
            [t for t in (img.tvec for img in model.images.values())], dtype=np.float64
        ).reshape(-1, 3)
        mean_c = centers.mean(axis=0)
        spanning = float(np.linalg.norm(centers.max(axis=0) - centers.min(axis=0)))
        radius = max(spanning, 1.0)
        means = torch.tensor(
            mean_c[None, :] + (rng.standard_normal((256, 3)) * radius * 0.3),
            dtype=dtype,
            device=device,
        )
        colors = torch.tensor(rng.random((256, 3)), dtype=dtype, device=device)
        scene_scale = radius

    n = means.shape[0]
    # gsplat stores parameters in "analytic" space: scales are log-scales and
    # opacities are logits (simple_trainer applies torch.exp / torch.sigmoid at
    # the rasterization call; DefaultStrategy's densification ops also undo log /
    # logit internally). log(0.001*scene_scale) yields the spec's requested
    # LINEAR scale of 0.001*scene_scale after exp.
    scales = torch.full(
        (n, 3), float(math.log(max(0.001 * scene_scale, 1e-8))), dtype=dtype, device=device
    )
    quats = torch.tensor([[1.0, 0.0, 0.0, 0.0]] * n, dtype=dtype, device=device)
    # Opacity logit for sigma == 0.1 (spec); linearized via sigmoid at render.
    opacities = torch.full((n,), float(torch.logit(torch.tensor(0.1))), dtype=dtype, device=device)
    sh0 = colors.unsqueeze(1)  # [N, 1, 3]
    shN = torch.zeros((n, 0, 3), dtype=dtype, device=device)
    return means, scales, quats, opacities, sh0, shN, scene_scale


# --------------------------------------------------------------------------- #
# Camera handling
# --------------------------------------------------------------------------- #
def build_camera_data(model, images_dir: Path, downscale: int, device: torch.device,
                      dtype: torch.dtype) -> tuple[list[dict], list[Path | None]]:
    """Build per-image (viewmat, K) from COLMAP and locate each frame on disk.

    ``images`` may use either ``some/path.jpg`` or ``some/path.png``; PIL handles
    the codec, and mismatches fail via a lenient ``_load_frame`` per frame so one
    corrupt file can't sink the whole job. Returns views + a parallel list of
    frame paths (or ``None`` placeholders retained for indexing stability).
    """
    views: list[dict] = []
    frames: list[Path | None] = []
    for img in model.images.values():
        qvec = torch.tensor(img.qvec, dtype=dtype, device=device)  # (w,x,y,z)
        rot = normalized_quat_to_rotmat(qvec)  # [3,3], R_world->cam
        tvec = torch.tensor(img.tvec, dtype=dtype, device=device)
        viewmat = torch.zeros((4, 4), dtype=dtype, device=device)
        viewmat[:3, :3] = rot
        viewmat[:3, 3] = tvec
        viewmat[3, 3] = 1.0
        cam = model.cameras.get(img.camera_id)
        if cam is None:
            continue
        fx, fy, cx, cy = cam.focal_xy_cxy()
        K = torch.tensor(
            [[fx / downscale, 0.0, cx / downscale],
             [0.0, fy / downscale, cy / downscale],
             [0.0, 0.0, 1.0]],
            dtype=dtype, device=device,
        )
        views.append({"viewmat": viewmat, "K": K, "camera": cam})
        frames.append(_find_frame(images_dir, img.name))
    return views, frames


def _find_frame(images_dir: Path, name: str) -> Path | None:
    """Match one COLMAP image name to a file under *images_dir*.

    Tries the relative name verbatim, then its ``.jpg``/``.jpeg``/``.png``
    variants, then a flat basename search (COLMAP restores a nested path, the
    extractor writes flat ``frame_NNNNN.jpg``).
    """
    candidates = [images_dir / name]
    stem = Path(name).stem
    for ext in (".jpg", ".jpeg", ".png"):
        candidates.append(images_dir / (stem + ext))
        candidates.append(images_dir / Path(name).name)  # flat variant
    seen: set[Path] = set()
    for cand in candidates:
        if cand in seen:
            continue
        seen.add(cand)
        try:
            if cand.is_file():
                return cand
        except OSError:
            continue
    # Flat glob fallback (COLMAP image name might be nested, extractor flat).
    try:
        flat = list(images_dir.glob(f"*{stem}.jpg")) + list(images_dir.glob(f"*{stem}.png"))
        if flat:
            return sorted(flat)[0]
    except OSError:
        pass
    return None


def _load_frame(path: Path, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """Load one frame as a ``[H, W, 3]`` float tensor in [0, 1] (CPU-then-device)."""
    from PIL import Image

    with Image.open(path) as im:
        rgb = im.convert("RGB")
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.tensor(arr, dtype=dtype, device=device).requires_grad_(False)


# --------------------------------------------------------------------------- #
# Checkpointing
# --------------------------------------------------------------------------- #
def _checkpoint_dir_from_cache(cache: dict) -> dict:
    """Rebuild the strategy-state tensors from a checkpoint ``cache``."""
    return {
        "grad2d": cache.get("grad2d"),
        "count": cache.get("count"),
        "scene_scale": cache.get("scene_scale", 1.0),
        "radii": cache.get("radii"),
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Train 3D Gaussians from a COLMAP sparse model")
    ap.add_argument("--colmap-dir", type=Path, required=True, help="COLMAP sparse/<N> dir (cameras.bin etc.)")
    ap.add_argument("--images-dir", type=Path, required=True, help="Extracted image frames")
    ap.add_argument("--output", type=Path, required=True, help="Output PLY path")
    ap.add_argument("--iterations", type=int, default=1200, help="Training iterations (profile gsplat.iterations)")
    ap.add_argument("--sh-degree", type=int, default=0, help="Spherical harmonics degree")
    ap.add_argument("--lr", type=float, default=0.01, help="Base learning rate")
    ap.add_argument("--downscale", type=int, default=1, help="Image downscale factor (divides focal length & principal point)")
    ap.add_argument("--save-interval", type=int, default=200, help="Checkpoints every N iterations")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--device", type=str, default="cuda:0")
    ap.add_argument("--checkpoint-dir", type=Path, default=None,
                    help="Optional dir; resumes from the latest checkpoint inside if present")
    ap.add_argument("--cancel-file", type=Path, default=None,
                    help="Optional file; if it exists mid-run, exit cleanly")
    ap.add_argument("--min-splats", type=int, default=100, help="Minimum splat count required in output")
    return ap.parse_args(argv)


def _log_error(code: str, message: str) -> None:
    print(f"ERROR {code}: {message}", file=sys.stderr, flush=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    start_wall = time.monotonic()

    try:
        device = torch.device(args.device)
        if device.type == "cuda" and not torch.cuda.is_available():
            _log_error("NO_CUDA", f"CUDA unavailable for --device {args.device}")
            return 1
        torch.manual_seed(args.seed)
        np.random.seed(args.seed)
        torch.cuda.manual_seed_all(args.seed) if device.type == "cuda" else None
        dtype = torch.float32
        rng = np.random.default_rng(args.seed)

        # 1. Load the COLMAP model.
        model = read_sparse_model(args.colmap_dir)
        if model.registered_image_count < 3:
            _log_error("NOT_ENOUGH_IMAGES", f"只找到 {model.registered_image_count} 张已注册图像（需要 >= 3）")
            return 1
        print(f"COLMAP model loaded: {model.registered_image_count} images, {model.point_count} points", flush=True)

        # 2. Cameras + frames.
        views, frames = build_camera_data(model, args.images_dir, args.downscale, device, dtype)
        if not views:
            _log_error("NO_CAMERAS", "COLMAP 模型没有可用的相机")
            return 1
        height, width = views[0]["camera"].height, views[0]["camera"].width

        missing = sum(1 for f in frames if f is None)
        if missing:
            print(f"WARN {missing}/{len(frames)} COLMAP 图像在 --images-dir 未找到，将仅使用可用帧", flush=True)
        available = [i for i, f in enumerate(frames) if f is not None]
        if len(available) < 3:
            _log_error("NOT_ENOUGH_IMAGES", f"实际可用帧只有 {len(available)} 张（需要 >= 3）")
            return 1

        full_viewmats = torch.stack([views[i]["viewmat"] for i in available], dim=0)  # [C,4,4]
        full_Ks = torch.stack([views[i]["K"] for i in available], dim=0)              # [C,3,3]

        # 3. Detect an existing checkpoint BEFORE sizing params: after
        # densification the checkpoint holds more splats than the fresh init,
        # so params must be constructed at the checkpoint's size, not the
        # point-cloud init's size.
        start_step = 0
        best_loss = float("inf")
        ckpt_path = None
        ckpt_meta: dict | None = None
        if args.checkpoint_dir is not None:
            ckpt_path = _latest_checkpoint(args.checkpoint_dir)
            if ckpt_path is not None:
                ckpt_meta = torch.load(ckpt_path, map_location=device, weights_only=True)

        if ckpt_meta is not None:
            means = ckpt_meta["params"]["means"].to(device).clone()
            scales = ckpt_meta["params"]["scales"].to(device).clone()
            quats = ckpt_meta["params"]["quats"].to(device).clone()
            opacities = ckpt_meta["params"]["opacities"].to(device).clone()
            sh0 = ckpt_meta["params"]["sh0"].to(device).clone()
            shN = ckpt_meta["params"]["shN"].to(device).clone()
            scene_scale = float(ckpt_meta.get("strategy_state", {}).get("scene_scale", 1.0))
            n_splats = means.shape[0]
            start_step = int(ckpt_meta.get("step", 0)) + 1
            best_loss = float(ckpt_meta.get("best_loss", float("inf")))
        else:
            means, scales, quats, opacities, sh0, shN, scene_scale = _init_from_points(
                model, device, dtype, rng
            )
            n_splats = means.shape[0]
            K_deg = (args.sh_degree + 1) ** 2
            if shN.shape[1] != max(K_deg - 1, 0):
                shN = torch.zeros((n_splats, max(K_deg - 1, 0), 3), dtype=dtype, device=device)

        # 4. Params + optimizers (1:1 mapping, required by DefaultStrategy's sanity check).
        param_names = ["means", "scales", "quats", "opacities", "sh0", "shN"]
        params = {
            "means": torch.nn.Parameter(means),
            "scales": torch.nn.Parameter(scales),
            "quats": torch.nn.Parameter(quats),
            "opacities": torch.nn.Parameter(opacities),
            "sh0": torch.nn.Parameter(sh0),
            "shN": torch.nn.Parameter(shN),
        }
        for p in params.values():
            p.requires_grad_(True)
        lrs: dict[str, float] = {
            "means": args.lr,
            "scales": args.lr,
            "quats": args.lr,
            "opacities": args.lr * 10.0,
            "sh0": args.lr / 10.0,
            "shN": args.lr / 10.0,
        }
        optimizers = {name: torch.optim.Adam([params[name]], lr=lrs[name]) for name in param_names}

        if ckpt_meta is not None:
            for name, opt in optimizers.items():
                if name in ckpt_meta.get("optimizer_state", {}):
                    opt.load_state_dict(ckpt_meta["optimizer_state"][name])
            print(f"RESUMED from {ckpt_path} at step {start_step}", flush=True)

        strategy = DefaultStrategy(verbose=False)
        strategy.check_sanity(params, optimizers)
        strategy_state = strategy.initialize_state(scene_scale=scene_scale)
        # Restore the densification running statistics on resume so grow/prune
        # decisions keep their continuity (counts/acc-grads are per-splat state).
        if ckpt_meta is not None:
            saved_state = ckpt_meta.get("strategy_state", {})
            for key in ("grad2d", "count", "radii"):
                if key in strategy_state and saved_state.get(key) is not None:
                    strategy_state[key] = saved_state[key].to(device)

        # 5. Training loop.
        total = args.iterations
        n_images = len(available)
        batch_size = min(4, n_images)
        final_loss = best_loss
        cancelled = False

        for step in range(start_step, total):
            try:
                torch.cuda.empty_cache()
                idxs = torch.randint(0, n_images, (batch_size,), device=device)
                viewmats = torch.index_select(full_viewmats, 0, idxs)
                Ks = torch.index_select(full_Ks, 0, idxs)
                targets = torch.stack([
                    _load_frame(frames[available[int(i)]], device, dtype)  # type: ignore[arg-type]
                    for i in idxs.tolist()], dim=0)

                images, alphas, info = rasterization(
                    means=params["means"],
                    quats=params["quats"],
                    scales=torch.exp(params["scales"]),
                    opacities=torch.sigmoid(params["opacities"]),
                    colors=torch.cat([params["sh0"], params["shN"]], dim=1),
                    viewmats=viewmats, Ks=Ks, width=width, height=height,
                    sh_degree=args.sh_degree, packed=False,
                )
                images = images[..., :3]  # RGB mode already; defensive slice
                assert images.shape == targets.shape, f"render {images.shape} != target {targets.shape}"

                strategy.step_pre_backward(params, optimizers, strategy_state, step, info)

                # Plain L1 over the rendered frame (spec: L1 loss, rendered vs
                # target image). Gradients flow to every pixel a splat touches;
                # empty background pixels contribute a constant offset only.
                loss = torch.abs(images - targets).mean()

                for opt in optimizers.values():
                    opt.zero_grad(set_to_none=True)
                loss.backward()
                for p in params.values():
                    if p.grad is not None:
                        torch.nan_to_num_(p.grad, nan=0.0, posinf=0.0, neginf=0.0)
                if not torch.isfinite(loss).item():
                    _log_error("NAN_LOSS", f"step {step} loss 非有限（{loss.item():.6f}），中止")
                    return 1

                for opt in optimizers.values():
                    opt.step()

                strategy.step_post_backward(params, optimizers, strategy_state, step, info)

                with torch.no_grad():
                    final_loss = float(loss.detach())
                    if final_loss < best_loss:
                        best_loss = final_loss

                if step % 10 == 0 or step == total - 1:
                    print(f"GSITER step={step} total={total} loss={final_loss:.6f}", flush=True)

                if args.checkpoint_dir is not None and args.save_interval > 0 and step % args.save_interval == 0:
                    _save_checkpoint(args, params, optimizers, strategy_state, step, best_loss)

                if args.cancel_file is not None and step % 100 == 0 and args.cancel_file.exists():
                    print(f"CANCELLED at step {step} (cancel-file present)", flush=True)
                    cancelled = True
                    break

            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                _log_error("GPU_OOM", f"step {step} CUDA 显存不足（已尽力释放）")
                return 1

        elapsed = time.monotonic() - start_wall
        print(f"training wall time: {elapsed:.1f}s ({elapsed / max(1, total - start_step):.3f}s/iter)", flush=True)

        # 6. Final checkpoint (also on cancel, so partial progress is resumable).
        if args.checkpoint_dir is not None:
            _save_checkpoint(args, params, optimizers, strategy_state, total - 1, best_loss)

        if cancelled:
            # Soft stop: exit 0 but never claim TRAINING_DONE — the orchestrator
            # requested the cancel and must not treat the run as completed.
            return 0

        # 7. Export PLY.
        args.output.parent.mkdir(parents=True, exist_ok=True)
        final_means = params["means"].detach().clone()
        final_scales = params["scales"].detach().clone()
        final_quats = params["quats"].detach().clone()
        final_opacities = params["opacities"].detach().clone()
        final_sh0 = params["sh0"].detach().clone()
        final_shN = params["shN"].detach().clone()
        try:
            export_splats(
                final_means, final_scales, final_quats, final_opacities,
                final_sh0, final_shN, format="ply", save_to=str(args.output),
            )
        except Exception as exc:  # noqa: BLE001 — surface the raw exporter error
            _log_error("EXPORT_FAIL", f"gsplat 导出失败: {exc}")
            return 1

        # 8. Validate.
        n_out = int(final_means.shape[0])
        all_finite = bool(
            torch.isfinite(final_means).all().item()
            and torch.isfinite(final_scales).all().item()
            and torch.isfinite(final_quats).all().item()
            and torch.isfinite(final_opacities).all().item()
            and torch.isfinite(final_sh0).all().item()
            and torch.isfinite(final_shN).all().item()
        )
        if not all_finite:
            _log_error("NAN_PARAMS", "训练输出存在 NaN/Inf，已清理")
            return 1
        if n_out < args.min_splats:
            _log_error("TOO_FEW_SPLATS", f"输出只有 {n_out} 个高斯（需要 >= {args.min_splats}）")
            return 1

        print(f"TRAINING_DONE splats={n_out} loss={final_loss:.6f}", flush=True)
        return 0

    except FileNotFoundError as exc:
        _log_error("MISSING_INPUT", str(exc))
        return 1
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        _log_error("GPU_OOM", "CUDA 显存不足")
        return 1
    except Exception as exc:  # noqa: BLE001 — last-resort guard for the orchestrator
        import traceback

        _log_error("UNEXPECTED", f"{type(exc).__name__}: {exc}")
        traceback.print_exc(file=sys.stderr)
        return 1


# --------------------------------------------------------------------------- #
# Checkpoint helpers
# --------------------------------------------------------------------------- #
def _latest_checkpoint(checkpoint_dir: Path) -> Path | None:
    """Highest-numbered `checkpoint_<step>.pt` under *checkpoint_dir*."""
    try:
        ckpts = list(checkpoint_dir.glob("checkpoint_*.pt"))
    except OSError:
        return None
    if not ckpts:
        return None

    def key(p: Path) -> int:
        try:
            return int(p.stem.split("_")[-1])
        except (ValueError, IndexError):
            return -1

    return max(ckpts, key=key)


def _save_checkpoint(args, params, optimizers, strategy_state, step: int, best_loss: float) -> None:
    assert args.checkpoint_dir is not None
    args.checkpoint_dir.mkdir(parents=True, exist_ok=True)
    cache = {
        "means": params["means"].detach().clone(),
        "scales": params["scales"].detach().clone(),
        "quats": params["quats"].detach().clone(),
        "opacities": params["opacities"].detach().clone(),
        "sh0": params["sh0"].detach().clone(),
        "shN": params["shN"].detach().clone(),
    }
    optimizer_state = {name: opt.state_dict() for name, opt in optimizers.items()}
    payload = {
        "params": cache,
        "optimizer_state": optimizer_state,
        "strategy_state": {
            "grad2d": strategy_state.get("grad2d"),
            "count": strategy_state.get("count"),
            "radii": strategy_state.get("radii"),
            "scene_scale": strategy_state.get("scene_scale", 1.0),
        },
        "step": step,
        "best_loss": best_loss,
        "iterations": args.iterations,
        "sh_degree": args.sh_degree,
    }
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=str(args.checkpoint_dir), prefix=f"checkpoint_{step}.", suffix=".pt.tmp"
    )
    os.close(tmp_fd)
    try:
        torch.save(payload, tmp_path)
        os.replace(tmp_path, args.checkpoint_dir / f"checkpoint_{step:06d}.pt")
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    finally:
        # Clean up any stale tmp files from interrupted runs.
        try:
            for stale in args.checkpoint_dir.glob("*.tmp"):
                stale.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
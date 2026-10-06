#!/usr/bin/env python3
"""verify_reconstruction_runtime.py — GPU reconstruction runtime gate (FIX-06.1).

Run with the venv that must contain the reconstruction toolchain, from anywhere
(the script locates the repo root from its own path):

    apps/api/.venv/bin/python deploy/scripts/verify_reconstruction_runtime.py

Proves, in order — every failure exits non-zero, nothing is swallowed:

  1. torch is importable and exactly ``2.14.0+cu126`` (contract version).
  2. gsplat is importable and exactly ``1.5.3`` (Phase-07-recorded contract).
  3. the training entry ``python -m workers.reconstruction.train_gsplat_script
     --help`` exits 0 from the tracked tree.
  4. ``torch.cuda.is_available()`` is True and at least one device is visible.
  5. a minimal CUDA rasterization actually executes through the gsplat 1.5.3
     API (viewmats/Ks — the same call shape the trainer uses), proving the CUDA
     extension is loadable and executable on real hardware.

``--allow-no-gpu`` relaxes only checks 4–5 (they print ``SKIPPED_NO_GPU`` and do
not fail) so CI machines without a GPU can still prove checks 1–3 — but a run
without the flag on a GPU-less host FAILS rather than silently passing, so no
one ever mistakes "imported but never executed" for a verified runtime.

Exit 0 only if all enabled checks hold.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# deploy/scripts -> deploy -> repo root.
REPO_ROOT = Path(__file__).resolve().parents[2]

CONTRACT_TORCH = "2.14.0+cu126"
CONTRACT_GSPLAT = "1.5.3"
MIN_SPLATS = 8

_FAIL = False


def fail(msg: str) -> None:
    global _FAIL
    _FAIL = True
    print(f"FAIL: {msg}")


def run_contract(name: str, fn) -> None:  # noqa: ANN001
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001 - every failure is fatal
        fail(f"{name}: {type(exc).__name__}: {exc}")
        return
    if ok:
        print(f"PASS: {name} — {detail}")
    else:
        fail(f"{name}: {detail}")


def _check_torch() -> tuple[bool, str]:
    import torch

    v = torch.__version__
    if v != CONTRACT_TORCH:
        return False, f"torch version {v} != contract {CONTRACT_TORCH}"
    return True, f"torch {v}"


def _check_gsplat() -> tuple[bool, str]:
    import gsplat

    v = getattr(gsplat, "__version__", "unknown")
    if v != CONTRACT_GSPLAT:
        return False, f"gsplat version {v} != contract {CONTRACT_GSPLAT}"
    return True, f"gsplat {v}"


def _check_trainer_help() -> tuple[bool, str]:
    env = {"PYTHONPATH": str(REPO_ROOT), **dict(os.environ)}
    out = subprocess.run(
        [sys.executable, "-m", "workers.reconstruction.train_gsplat_script", "--help"],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        cwd=str(REPO_ROOT),
    )
    if out.returncode != 0:
        tail = (out.stderr or out.stdout).strip().splitlines()[-3:]
        return False, f"train_gsplat_script --help exited {out.returncode}: {' | '.join(tail)}"
    if "usage" not in (out.stdout + out.stderr).lower():
        return False, "--help printed no usage"
    return True, "python -m workers.reconstruction.train_gsplat_script --help exit 0"


def _check_cuda() -> tuple[bool, str]:
    import torch

    if not torch.cuda.is_available():
        return False, "torch.cuda.is_available() is False"
    n = torch.cuda.device_count()
    if n < 1:
        return False, f"torch.cuda.device_count() == {n}"
    return True, f"CUDA available, {n} device(s): {torch.cuda.get_device_name(0)}"


def _check_rasterization() -> tuple[bool, str]:
    """Minimal gsplat 1.5.3 CUDA rasterization — mirrors the trainer's call shape
    (``opacities`` as ``(N,)``, ``viewmats``/``Ks`` intrinsics)."""
    import torch
    from gsplat import rasterization

    dev = "cuda:0"
    N = MIN_SPLATS
    means = torch.randn(N, 3, device=dev)
    quats = torch.randn(N, 4, device=dev)
    quats = quats / quats.norm(dim=-1, keepdim=True)
    scales = torch.rand(N, 3, device=dev) * 0.05 + 0.01
    opacities = torch.full((N,), 0.8, device=dev)
    colors = torch.rand(N, 3, device=dev)

    width, height = 32, 32
    viewmats = torch.eye(4, device=dev)[None].clone()
    viewmats[0, 2, 3] = 3.0  # camera on +z looking at the origin
    Ks = torch.tensor(
        [[[50.0, 0.0, width / 2], [0.0, 50.0, height / 2], [0.0, 0.0, 1.0]]],
        device=dev,
    )

    images, alphas, _info = rasterization(
        means=means, quats=quats, scales=scales, opacities=opacities, colors=colors,
        viewmats=viewmats, Ks=Ks, width=width, height=height,
        near_plane=0.01, far_plane=100.0,
    )
    torch.cuda.synchronize()

    if tuple(images.shape) != (1, height, width, 3):
        return False, f"unexpected image shape {tuple(images.shape)}"
    if float(alphas.sum()) <= 0.0:
        return False, "rasterization produced no visible splats"
    pixels = int((images.sum(-1)[0] > 0).sum())
    return True, f"gsplat CUDA rasterization OK ({pixels} lit pixels, {N} splats)"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-no-gpu",
        action="store_true",
        help="skip (do not fail) the CUDA/rasterization checks when no GPU is present",
    )
    args = parser.parse_args()

    print("verify_reconstruction_runtime.py")
    print(f"  repo: {REPO_ROOT}")
    print(f"  contract: torch=={CONTRACT_TORCH} gsplat=={CONTRACT_GSPLAT}")

    run_contract("torch import + version", _check_torch)
    run_contract("gsplat import + version", _check_gsplat)
    run_contract("trainer entry --help", _check_trainer_help)

    if _allow_no_gpu_skip(args.allow_no_gpu):
        print("SKIPPED_NO_GPU: CUDA availability + rasterization not verified (--allow-no-gpu)")
    else:
        run_contract("CUDA availability", _check_cuda)
        run_contract("gsplat CUDA rasterization", _check_rasterization)

    if _FAIL:
        print("RESULT: FAIL — reconstruction runtime not verified")
        return 1
    print("RESULT: PASS — reconstruction runtime verified")
    return 0


def _allow_no_gpu_skip(flag: bool) -> bool:
    if not flag:
        return False
    try:
        import torch

        return not torch.cuda.is_available()
    except Exception:  # noqa: BLE001 - torch missing counts as "no GPU usable"
        return True


if __name__ == "__main__":
    sys.exit(main())

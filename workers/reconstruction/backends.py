"""Trusted, operator-configured reconstruction backends (never request paths)."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

ALGORITHMS = ("gsplat", "2dgs")


def validate_algorithm(value: str) -> str:
    if value not in ALGORITHMS:
        raise ValueError(f"不支持的重建算法: {value}")
    return value


def surfel_runtime() -> tuple[Path, Path]:
    repo = (
        Path(
            os.environ.get("GS_2DGS_REPO", "/data/fj/F2DMAS/2d-gaussian-splatting-main")
        )
        .expanduser()
        .absolute()
    )
    python = (
        Path(os.environ.get("GS_2DGS_PYTHON", str(repo / "venv/bin/python")))
        .expanduser()
        .absolute()
    )
    if not (repo / "train.py").is_file() or not python.is_file():
        raise ValueError(
            "2DGS 环境不可用，请配置 GS_2DGS_REPO 和 GS_2DGS_PYTHON；"
            "不会自动改用通用重建"
        )
    # CommandRunner deliberately accepts only the trusted python executable.
    if python.name != "python":
        raise ValueError("GS_2DGS_PYTHON 必须指向环境的 bin/python")
    return repo, python


def backend_identity(algorithm: str) -> dict:
    validate_algorithm(algorithm)
    identity = {"algorithm": algorithm, "adapterVersion": 1}
    if algorithm == "2dgs":
        repo, python = surfel_runtime()
        # The reused repository can change independently of this platform.
        digest = hashlib.sha256()
        paths = [repo / "train.py"]
        for directory in ("arguments", "scene", "gaussian_renderer", "utils"):
            paths.extend((repo / directory).rglob("*.py"))
        for path in sorted(paths):
            digest.update(str(path.relative_to(repo)).encode())
            digest.update(path.read_bytes())
        identity.update(
            repo=str(repo), python=str(python), sourceSha256=digest.hexdigest()
        )
    return identity

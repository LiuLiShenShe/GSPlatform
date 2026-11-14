"""Trusted operator configuration for the existing meshing environments."""

import os
from pathlib import Path

from workers.reconstruction.backends import surfel_runtime


def mesh_runtime(algorithm: str) -> tuple[Path, Path]:
    if algorithm == "2dgs":
        repo, python = surfel_runtime()
        if not (repo / "utils/mesh_utils.py").is_file():
            raise ValueError("2DGS 原生网格提取器不可用")
        return python, repo
    if algorithm != "gsplat":
        raise ValueError("不支持的网格算法")
    python = Path(os.environ.get("GS_NKSR_PYTHON", "/not-configured"))
    weights = Path(os.environ.get("GS_NKSR_WEIGHTS", "/not-configured"))
    if not python.is_file() or python.name != "python" or not weights.is_file():
        raise ValueError("NKSR 环境未配置，请配置 GS_NKSR_PYTHON 和 GS_NKSR_WEIGHTS")
    return python.absolute(), weights.absolute()

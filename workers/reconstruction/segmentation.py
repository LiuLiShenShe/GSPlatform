"""Host-configured official SAM3 subprocess; files form the environment boundary."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from functools import lru_cache
from pathlib import Path


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=8)
def _checkpoint_hash(path: str, size: int, modified_ns: int) -> str:
    return file_sha256(Path(path))


def runtime_paths() -> dict:
    """Configuration comes from the operator, never from a reconstruction request."""
    names = {
        "python": "GS_SAM3_PYTHON",
        "source": "GS_SAM3_SOURCE",
        "checkpoint": "GS_SAM3_CHECKPOINT",
    }
    paths = {}
    for key, variable in names.items():
        value = os.environ.get(variable, "")
        if not value or not Path(value).exists():
            raise ValueError(f"SAM3 环境未配置：{variable}")
        paths[key] = str(Path(value).absolute())
    return paths


def runtime_identity() -> dict:
    paths = runtime_paths()
    source = Path(paths["source"])
    version = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout.strip()
    dirty = subprocess.run(
        ["git", "-C", str(source), "diff", "HEAD", "--", "sam3"],
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    checkpoint = Path(paths["checkpoint"])
    stat = checkpoint.stat()
    return {
        **paths,
        "commit": version,
        "sourceDiffSha256": hashlib.sha256(dirty).hexdigest(),
        "checkpointSha256": _checkpoint_hash(
            str(checkpoint), stat.st_size, stat.st_mtime_ns
        ),
        "confidenceThreshold": 0.5,
        "adapterVersion": 2,
    }


def validate_manifest(
    directory: Path, images_dir: Path, *, minimum_views: int = 3
) -> dict:
    """Reject missing, empty, changed, mis-sized or substituted segmentation inputs."""
    from PIL import Image

    manifest = json.loads((directory / "manifest.json").read_text())
    names = [frame["name"] for frame in manifest["frames"]]
    expected = {
        p.name
        for p in images_dir.iterdir()
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    }
    if len(names) != len(set(names)) or set(names) != expected:
        raise ValueError("分割清单必须与全部重建照片一一对应")
    valid = 0
    for frame in manifest["frames"]:
        name = frame["name"]
        if Path(name).name != name:
            raise ValueError("分割帧名称非法")
        image_path = images_dir / name
        mask_path = directory / "masks" / (name + ".png")
        with Image.open(image_path) as image, Image.open(mask_path) as mask:
            if list(image.size) != frame["size"] or mask.size != image.size:
                raise ValueError(f"掩膜尺寸不匹配：{name}")
            if file_sha256(image_path) != frame["imageSha256"]:
                raise ValueError(f"分割原图已变化：{name}")
            if file_sha256(mask_path) != frame["maskSha256"]:
                raise ValueError(f"分割掩膜已变化：{name}")
            import numpy as np

            pixels = np.asarray(mask)
            if not np.isin(pixels, [0, 255]).all():
                raise ValueError(f"掩膜不是二值前景：{name}")
            area = int((pixels > 0).sum())
            if area != frame["foregroundPixels"]:
                raise ValueError(f"掩膜统计不匹配：{name}")
            valid += area > 0
    if valid < minimum_views:
        raise ValueError(
            f"SAM3 只有 {valid} 个有效目标视角，至少需要 {minimum_views} 个；请检查目标提示词和拍摄视角"
        )
    return manifest

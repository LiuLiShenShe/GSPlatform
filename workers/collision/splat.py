"""Collision artifact generator — official splat-transform voxelization (SSV-07).

The official SuperSplat viewer's collision loaders were written against the
files splat-transform writes:

  - ``*.voxel.json`` + ``*.voxel.bin``  → ``VoxelCollision`` (native voxel octree)
  - ``*.glb`` (``--collision-mesh``)    → ``MeshCollision`` (mesh fallback)

Note the two-part ``.voxel.json`` extension is load-bearing: the official viewer
derives the binary url as ``<jsonUrl>.replace('.voxel.json', '.voxel.bin')``, and
splat-transform itself only recognises ``.voxel.json`` as an output type.

This module invokes the pinned splat-transform CLI (same locked path the
streamed-SOG pipeline uses) to produce **both** artifacts from a scene's SOG /
lod-meta.json. The INDOOR / OUTDOOR distinction from Phase 12 is kept here as
a **generation policy** (SSV-07 §5): it selects the voxel flood-fill strategy,
never a viewer runtime mode.

  - INDOOR:  ``--voxel-carve``  — capsule flood-fill from a seed carves the
             navigable interior out of the solid occupancy.
  - OUTDOOR: ``--voxel-floor-fill`` — columns are filled upward from the bottom,
             producing terrain the player can stand on.

Prohibited (Phase 12): converting raw splats into millions of triangles and
colliding against all of them. Voxelization is coarse occupancy carving, never
raw-splat collision.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("gsplatform.collision.splat")

# Same pinned CLI location as workers/pipeline/convert_scene.py.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_NODE_BIN = (
    _REPO_ROOT
    / "node_modules"
    / ".pnpm"
    / "@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0"
    / "node_modules"
    / "@playcanvas"
    / "splat-transform"
    / "bin"
    / "cli.mjs"
)

_TIMEOUT = 600  # seconds — generous for large scenes on GPU.

# Voxel policy defaults (SSV-07 §5 generation policy; override via params).
_VOXEL_SIZE_DEFAULT = 0.05
_VOXEL_OPACITY_DEFAULT = 0.1
_CARVE_DEFAULT = (1.6, 0.2)  # (radius, capsule) for INDOOR
_FLOOR_FILL_DEFAULT = 1.6  # extent for OUTDOOR
_GPU_INDEX_DEFAULT = 0  # dev/worker GPU adapter index


class SplatCollisionError(RuntimeError):
    """Raised when splat-transform cannot produce a collision artifact."""


@dataclass(frozen=True)
class SplatBuildResult:
    """Paths + metadata for a successful collision build."""

    ok: bool
    out_dir: Path
    voxel_json: Path | None = None
    voxel_bin: Path | None = None
    collision_glb: Path | None = None
    voxel_meta: dict | None = None
    mode: str = ""
    gpu: str = ""
    warnings: list[str] = field(default_factory=list)

    def to_params(self) -> dict:
        """Serializable build metadata (stored in CollisionAsset.build_params)."""
        return {
            "tool": "splat-transform",
            "toolVersion": "3.3.3",
            "mode": self.mode,
            "gpu": self.gpu,
            "artifacts": {
                "voxelJson": self.voxel_json.name if self.voxel_json else None,
                "voxelBin": self.voxel_bin.name if self.voxel_bin else None,
                "collisionGlb": self.collision_glb.name if self.collision_glb else None,
            },
            "voxel": {
                k: self.voxel_meta.get(k)
                for k in (
                    "voxelResolution",
                    "nodeCount",
                    "leafDataCount",
                    "treeDepth",
                    "leafSize",
                )
            }
            if self.voxel_meta
            else None,
            "gridBounds": (self.voxel_meta or {}).get("gridBounds"),
            "warning": "; ".join(self.warnings) if self.warnings else None,
        }


def _resolve_cli() -> Path:
    if _NODE_BIN.exists():
        return _NODE_BIN
    exe = shutil.which("splat-transform")
    if exe:
        return Path(exe)
    raise SplatCollisionError(f"splat-transform CLI 不可用: {_NODE_BIN}")


def _run(cmd: list[str], timeout: int = _TIMEOUT) -> str:
    # check=True：CLI 非零退出时抛 CalledProcessError，但我们想要自定义
    # 错误信息（含 stdout/stderr 尾部），故用 returncode 手动判断。
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        raise SplatCollisionError(
            f"命令失败 (rc={result.returncode}): {cmd}\n"
            f"stdout:\n{result.stdout[-4000:]}\nstderr:\n{result.stderr[-4000:]}"
        )
    return result.stdout


def _scene_center(source: Path) -> tuple[float, float, float]:
    """Seed position for INDOOR carve: the scene bounds center.

    Reads ``tree.bound`` from a streamed lod-meta.json when present (cheap,
    no GPU work); otherwise defaults to (0, 0, 0).
    """
    try:
        if source.name == "lod-meta.json":
            meta = json.loads(source.read_text(encoding="utf-8"))
            b = (meta.get("tree") or {}).get("bound")
            if b and b.get("min") and b.get("max"):
                return tuple(
                    (a + c) / 2.0 for a, c in zip(b["min"], b["max"], strict=False)
                )
    except Exception as exc:  # noqa: BLE001 - best-effort seed
        logger.info("seed center fallback: %s", exc)
    return (0.0, 0.0, 0.0)


def build_collision_artifacts(
    source_path: Path,
    out_dir: Path,
    *,
    mode: str,
    gpu: str | None = None,
    voxel_size: float = _VOXEL_SIZE_DEFAULT,
    voxel_opacity: float = _VOXEL_OPACITY_DEFAULT,
) -> SplatBuildResult:
    """Produce voxel + mesh collision artifacts for a scene.

    Args:
        source_path: SOG / lod-meta.json / PLY path for the scene content.
        out_dir: Directory to write ``collision.voxel.json`` /
            ``collision.voxel.bin`` / ``collision.glb`` into.
        mode: INDOOR or OUTDOOR — the voxel **generation policy**.
        gpu: splat-transform ``-g`` selector; None → adapter 0 (NVIDIA) or cpu.
        voxel_size / voxel_opacity: voxelization params.

    Returns:
        :class:`SplatBuildResult`; ``ok`` is False only when no artifact at all
        could be produced (caller must mark the build FAILED). Missing one of
        the two artifact kinds is surfaced via ``warnings``, never silently.
    """
    cli = _resolve_cli()
    out_dir.mkdir(parents=True, exist_ok=True)
    node = shutil.which("node") or "node"

    # ── resolve GPU selector ────────────────────────────────────────────────
    # Voxel output is GPU-only. Prefer the NVIDIA adapter; if the worker has
    # none (llvmpipe only), splat-transform will fail and we degrade to a
    # mesh-only build rather than reporting a false success.
    if gpu is not None:
        gpu_sel = gpu
    else:
        try:
            out = subprocess.run(
                [node, str(cli), "--list-gpus"],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            has_nvidia = "NVIDIA" in out.stdout or "NVIDIA" in out.stderr
        except (OSError, subprocess.TimeoutExpired):
            has_nvidia = False
        gpu_sel = str(_GPU_INDEX_DEFAULT) if has_nvidia else "cpu"

    voxel_json = out_dir / "collision.voxel.json"
    voxel_bin = out_dir / "collision.voxel.bin"
    collision_glb = out_dir / "collision.glb"
    for stale in (voxel_json, voxel_bin, collision_glb):
        stale.unlink(missing_ok=True)

    warnings: list[str] = []
    voxel_meta: dict | None = None

    # ── INDOOR / OUTDOOR generation policy (SSV-07 §5) ──────────────────────
    seed_x, seed_y, seed_z = _scene_center(source_path)
    if mode == "INDOOR":
        carve_h, carve_r = _CARVE_DEFAULT
        policy_args = [
            "--voxel-carve", f"{carve_h},{carve_r}",
            "--seed-pos", f"{seed_x},{seed_y},{seed_z}",
        ]
    elif mode == "OUTDOOR":
        policy_args = ["--voxel-floor-fill", f"{_FLOOR_FILL_DEFAULT}"]
    else:
        raise SplatCollisionError(f"未知碰撞模式: {mode}")

    # ── 1) voxel octree (native official format, GPU-only) ──────────────────
    try:
        cmd = [
            node, str(cli), "-w", "-g", gpu_sel,
            str(source_path),
            "--voxel-size", str(voxel_size),
            "--voxel-opacity", str(voxel_opacity),
            *policy_args,
            str(voxel_json),
        ]
        _run(cmd)
        if not voxel_json.exists() or not voxel_bin.exists():
            raise SplatCollisionError(
                "voxel 输出缺失: "
                f"json={voxel_json.exists()} bin={voxel_bin.exists()}"
            )
        voxel_meta = json.loads(voxel_json.read_text(encoding="utf-8"))
        voxel_meta.setdefault("mode", mode)
        logger.info(
            "voxel OK scene=%s mode=%s nodes=%s leaves=%s",
            source_path.name, mode,
            voxel_meta.get("nodeCount"), voxel_meta.get("leafDataCount"),
        )
    except SplatCollisionError as exc:
        # GPU unavailable / tool failure → degrade to mesh-only, honestly.
        voxel_json.unlink(missing_ok=True)
        voxel_bin.unlink(missing_ok=True)
        warnings.append(f"voxel 生成失败: {exc}")
        logger.warning("voxel generation failed, degrading to mesh: %s", exc)

    # ── 2) collision mesh (GLB fallback, official MeshCollision format) ─────
    try:
        cmd = [
            node, str(cli), "-w", "-g", gpu_sel,
            str(source_path),
            "--collision-mesh", "faces",
            str(collision_glb),
        ]
        _run(cmd)
        if not collision_glb.exists():
            raise SplatCollisionError("collision.glb 输出缺失")
        logger.info("collision mesh OK bytes=%d", collision_glb.stat().st_size)
    except SplatCollisionError as exc:
        collision_glb.unlink(missing_ok=True)
        warnings.append(f"collision mesh 生成失败: {exc}")
        logger.warning("collision mesh generation failed: %s", exc)

    if voxel_meta is not None and voxel_json.exists():
        ok = True
    elif collision_glb.exists():
        # Mesh-only build (e.g. GPU unavailable for voxelization): serveable,
        # surfaced via warnings so it is never silently passed.
        ok = True
    else:
        ok = False

    return SplatBuildResult(
        ok=ok,
        out_dir=out_dir,
        voxel_json=voxel_json if voxel_json.exists() else None,
        voxel_bin=voxel_bin if voxel_bin.exists() else None,
        collision_glb=collision_glb if collision_glb.exists() else None,
        voxel_meta=voxel_meta,
        mode=mode,
        gpu=gpu_sel,
        warnings=warnings,
    )

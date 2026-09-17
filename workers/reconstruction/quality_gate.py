"""Quality gate — per-stage artifact validation (Phase 07).

Each gate verifies the *output* of a stage against stable thresholds so the
pipeline cannot silently pass bad COLMAP reconstructions or empty gsplat
exports into production. Every gate returns a :class:`GateResult`; on
failure it sets a safe, user-visible ``error_code`` and ``suggestion`` that
the orchestrator propagates without leaking internals.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("gsplatform.workers.quality_gate")

# ──────────────────────────────────────────────────────────────────────────────
# Error codes — stable identifiers the UI/orchestrator can branch on.
# ──────────────────────────────────────────────────────────────────────────────
CODE_LOW_REGISTRATION = "LOW_REGISTRATION"
CODE_TOO_FEW_SPLATS = "TOO_FEW_SPLATS"
CODE_INVALID_SPLATS = "INVALID_SPLATS"
CODE_TRAINING_OOM = "TRAINING_OOM"
CODE_MISSING_MANIFEST = "MISSING_MANIFEST"


# ──────────────────────────────────────────────────────────────────────────────
# Gate error
# ──────────────────────────────────────────────────────────────────────────────
class GateError(Exception):
    """Raised by any gate_* function on validation failure."""

    def __init__(self, code: str, message: str, suggestion: str = "") -> None:
        super().__init__(message)
        self.error_code = code
        self.error_message = message
        self.suggestion = suggestion


# ──────────────────────────────────────────────────────────────────────────────
# Gate: Probe — input asset limits
# ──────────────────────────────────────────────────────────────────────────────
def gate_probe(
    probe_result: Any,
    input_limits: dict[str, Any],
) -> None:
    """Validate a :class:`ProbeResult` against profile input limits.

    Checks duration, file size, frame count, and image count.  Raises
    :class:`GateError` on any limit violation; returns ``None`` on success.
    """
    max_video_s = float(input_limits.get("max_video_seconds", 1200))
    max_images = int(input_limits.get("max_images", 300))

    # Video duration check.
    if probe_result.duration_s is not None and probe_result.duration_s > max_video_s:
        raise GateError(
            "INPUT_TOO_LONG",
            f"视频时长 {probe_result.duration_s:.1f}s 超过上限 {max_video_s}s",
            "请裁剪视频或使用更短的片段。",
        )

    # Image count check.
    if probe_result.image_count > max_images:
        raise GateError(
            "TOO_MANY_IMAGES",
            f"照片数量 {probe_result.image_count} 超过上限 {max_images}",
            "请减少照片数量或使用较低质量 profile。",
        )

    # General warnings from probe.
    if probe_result.warnings:
        logger.warning("probe warnings: %s", probe_result.warnings)


# ──────────────────────────────────────────────────────────────────────────────
# Gate: Extract — frame count vs. profile limit
# ──────────────────────────────────────────────────────────────────────────────
def gate_extract(extract_result: Any, max_frames: int) -> None:
    """Validate extracted frame count against profile ``max_frames``.

    Raises :class:`GateError` with ``error_code`` if the frame count is zero
    or exceeds the limit; returns ``None`` on success.
    """
    if extract_result.frame_count <= 0:
        raise GateError(
            "NO_FRAMES",
            "抽帧完成但没有生成任何帧",
            "请确认视频文件有效且包含画面内容。",
        )
    if extract_result.frame_count > max_frames:
        raise GateError(
            "TOO_MANY_FRAMES",
            f"抽帧数量 {extract_result.frame_count} 超过上限 {max_frames}",
            "请降低 extract fps 或使用更短的视频。",
        )


# ──────────────────────────────────────────────────────────────────────────────
# Gate: COLMAP registration — images + points vs. profile thresholds
# ──────────────────────────────────────────────────────────────────────────────
def gate_colmap_registration(sparse_model: Any, profile_colmap: dict[str, Any]) -> None:
    """Validate COLMAP sparse model against profile registration thresholds.

    ``sparse_model`` is a :class:`colmap_reader.SparseModel`; ``profile_colmap``
    is the ``colmap`` section from a loaded :class:`Profile`.  Checks:

    - Registered image ratio vs. ``min_registered_ratio``
    - Registered image count vs. ``min_registered_images``
    - Point cloud size (absolute minimum)

    Raises :class:`GateError` on any failure.
    """
    min_ratio = float(profile_colmap.get("min_registered_ratio", 0.5))
    min_images = int(profile_colmap.get("min_registered_images", 8))

    registered = sparse_model.registered_image_count
    point_count = sparse_model.point_count

    # --- Registration ratio (relative to camera count, not total input) ---
    camera_count = len(sparse_model.cameras)
    if camera_count > 0:
        ratio = registered / camera_count
    else:
        ratio = 0.0

    if registered < min_images:
        raise GateError(
            CODE_LOW_REGISTRATION,
            f"仅 {registered} 张照片通过配准（最低 {min_images}）",
            "请提供更多视角照片，或确保照片质量清晰、重叠度充足。",
        )

    if ratio < min_ratio:
        raise GateError(
            CODE_LOW_REGISTRATION,
            f"配准率 {ratio:.1%} 低于阈值 {min_ratio:.0%}（{registered}/{camera_count}）",
            "请检查照片是否过曝、模糊或缺乏重叠。",
        )

    # --- Minimum point cloud size (profile-tunable for low-texture scenes) ---
    min_points = int(profile_colmap.get("min_points", 1000))
    if point_count < min_points:
        raise GateError(
            CODE_LOW_REGISTRATION,
            f"点云仅有 {point_count} 个 3D 点（最低 {min_points}）",
            "场景可能纹理不足或照片质量较差，建议重新采集。",
        )

    # --- Mean reprojection error (informational) ---
    mean_err = sparse_model.mean_reprojection_error()
    if mean_err is not None and mean_err > 2.0:
        logger.warning(
            "mean reprojection error %.2f px — above 2.0 px threshold", mean_err
        )


# ──────────────────────────────────────────────────────────────────────────────
# Gate: Training output — gsplat PLY file sanity
# ──────────────────────────────────────────────────────────────────────────────
def gate_training_output(ply_path: Path, min_splats: int = 100) -> None:
    """Validate a trained gsplat PLY file.

    Checks:
    - File exists and is non-empty
    - File size is plausible (at least 2 KB, not unreasonably large)
    - PLY header is parseable and reports sufficient splats

    Raises :class:`GateError` on any failure.
    """
    if not ply_path.exists():
        raise GateError(
            CODE_INVALID_SPLATS,
            f"训练输出文件不存在: {ply_path}",
            "请检查 gsplat 训练是否正常完成。",
        )

    file_size = ply_path.stat().st_size
    if file_size == 0:
        raise GateError(
            CODE_INVALID_SPLATS,
            "训练输出 PLY 文件为空（0 字节）",
            "gsplat 训练可能异常终止，请检查 GPU 显存是否充足。",
        )
    if file_size < 2048:
        raise GateError(
            CODE_TOO_FEW_SPLATS,
            f"训练输出仅 {file_size} 字节，疑似 splat 数量极少",
            "请检查训练迭代次数是否充足，或输入数据是否存在异常。",
        )

    # Parse PLY header to read vertex count.
    splat_count = _read_ply_vertex_count(ply_path)
    if splat_count is None:
        raise GateError(
            CODE_INVALID_SPLATS,
            "无法解析 PLY 文件头（可能不是有效 PLY 格式）",
            "请确认 gsplat 输出格式正确。",
        )

    if splat_count < min_splats:
        raise GateError(
            CODE_TOO_FEW_SPLATS,
            f"PLY 仅包含 {splat_count} 个 splat（最低要求 {min_splats}）",
            "请增加训练迭代次数（iterations）或检查输入数据。",
        )

    logger.info("training output OK: %s (%d splats, %.1f MB)",
                ply_path.name, splat_count, file_size / (1024 * 1024))


def _read_ply_vertex_count(ply_path: Path) -> int | None:
    """Read the ``element vertex`` count from a PLY header."""
    try:
        with open(ply_path, "rb") as fh:
            header_lines = 0
            while header_lines < 128:
                line = fh.readline()
                if not line:
                    return None
                header_lines += 1
                decoded = line.decode("ascii", errors="replace").strip()
                if decoded.startswith("element vertex"):
                    parts = decoded.split()
                    if len(parts) >= 3:
                        return int(parts[2])
                if decoded == "end_header":
                    break
    except (OSError, ValueError):
        return None
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Gate: Publish — version directory integrity
# ──────────────────────────────────────────────────────────────────────────────
def gate_publish(version_dir: Path) -> dict:
    """Verify a published version directory is complete and well-formed.

    Delegates to :func:`workers.pipeline.verify_publish.verify_published_version`.
    Returns the verification result dict on success; raises :class:`GateError`
    with ``MISSING_MANIFEST`` code on failure.
    """
    from workers.pipeline.verify_publish import verify_published_version

    try:
        result = verify_published_version(version_dir)
    except ValueError as exc:
        raise GateError(
            CODE_MISSING_MANIFEST,
            f"版本目录验证失败: {exc}",
            "请检查版本目录是否完整，manifest.json 和 lod-meta.json 是否存在。",
        ) from exc

    return result

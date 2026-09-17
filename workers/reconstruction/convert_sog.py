"""Convert trained PLY to Streamed SOG — reuses Phase 06 convert_scene (Phase 07).

Thin wrapper that bridges the reconstruction pipeline's training output
(PLY or SPLAT) to the existing Phase 06 streamed-SOG conversion.  The
underlying ``convert_to_streamed_sog`` already accepts ``.splat`` (and other
splat formats) as a direct source path, so this module picks the *right
source path* — the training artifact itself — and adds friendly validation
and logging around the call.
"""

from __future__ import annotations

import logging
from pathlib import Path

from workers.pipeline.convert_scene import convert_to_streamed_sog, ConvertResult

logger = logging.getLogger("gsplatform.workers.convert_sog")

# Extensions ``convert_to_streamed_sog`` accepts as direct input (splat-transform
# detects the format by magic bytes, so no rename is needed for .splat).
_SUPPORTED_SOURCE_EXTS = {
    ".ply", ".sog", ".spz", ".splat", ".ksplat", ".lcc", ".lcc2", ".gz",
}


def convert_ply_to_streamed_sog(
    ply_path: Path,
    staging_dir: Path,
    scene_id: str,
    profile_name: str = "balanced",
    gpu: str = "cpu",
) -> ConvertResult:
    """Convert a trained gsplat output (PLY or SPLAT) to a streamed-SOG staging tree.

    ``ply_path`` is the training output — typically a ``.ply`` file but may
    also be a ``.splat`` file from an alternative trainer.  The right source
    path is passed straight through to :func:`convert_to_streamed_sog`, which
    handles both formats (splat-transform sniffs the format from magic bytes).

    Parameters
    ----------
    ply_path:
        Path to the trained PLY or SPLAT file.
    staging_dir:
        Fresh staging directory for the streamed-SOG output (the underlying
        converter clears and re-creates it).
    scene_id:
        Scene identifier embedded in the manifest.
    profile_name:
        Convert profile name (``balanced`` / ``eco`` / ``quality``).
    gpu:
        GPU device selector for ``splat-transform`` (``cpu`` / ``cuda:0`` / etc.).

    Returns
    -------
    ConvertResult
        The result from ``convert_to_streamed_sog``.
    """
    if not ply_path.exists():
        logger.error("Training output not found: %s", ply_path)
        return ConvertResult(
            ok=False,
            reason=f"训练输出文件不存在: {ply_path}",
        )

    if ply_path.suffix.lower() not in _SUPPORTED_SOURCE_EXTS:
        logger.error("Unsupported training output format: %s", ply_path.suffix)
        return ConvertResult(
            ok=False,
            reason=f"不支持的训练输出格式: {ply_path.suffix}（仅支持 .ply/.splat 等 splat 格式）",
        )

    logger.info(
        "converting %s (%s) -> streamed-SOG (scene=%s, profile=%s, gpu=%s)",
        ply_path.name, ply_path.suffix.lower(), scene_id, profile_name, gpu,
    )

    result = convert_to_streamed_sog(
        ply_path,
        staging_dir,
        scene_id=scene_id,
        profile=profile_name,
        gpu=gpu,
    )

    if result.ok:
        logger.info(
            "conversion OK: scene=%s, version=%s, entry_bytes=%d",
            scene_id, result.version_id, result.entry_bytes,
        )
    else:
        logger.error("conversion FAILED: %s", result.reason)

    return result

"""COLMAP CLI pipeline — feature extraction, matching, and sparse mapping.

Runs COLMAP 3.9.1 (CPU build) via :class:`CommandRunner` with argv lists only.
The three stages map to reconstruction phases:

1. ``FEATURES``: ``colmap feature_extractor``
2. ``MATCHING``: ``colmap exhaustive_matcher`` or ``colmap sequential_matcher``
3. ``MAPPING``:  ``colmap mapper``

Each stage returns a typed result dataclass.  ``run_colmap_pipeline`` chains
them and performs a quality gate on the resulting sparse model.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from workers.reconstruction.command_runner import CommandRunner, quote_argv
from workers.reconstruction.colmap_reader import read_sparse_model

logger = logging.getLogger("gsplatform.workers.colmap")


def clear_colmap_matches(db_path: Path) -> None:
    """Delete all rows from COLMAP's ``matches`` table.

    COLMAP's exhaustive matcher skips pairs that already have a row, so
    re-running it on a previously matched database reproduces the same
    (possibly bad) FLANN result. Clearing the table forces a fresh draw.
    """
    try:
        with sqlite3.connect(db_path) as con:
            con.execute("DELETE FROM matches")
    except sqlite3.Error as exc:  # e.g. read-only or locked
        logger.warning("failed to clear matches table %s: %s", db_path, exc)


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------

@dataclass
class FeatureResult:
    ok: bool
    total: int = 0
    extracted: int = 0
    error: str = ""
    detail: str = ""


@dataclass
class MatchResult:
    ok: bool
    error: str = ""
    detail: str = ""


@dataclass
class MapResult:
    ok: bool
    registered: int = 0
    total: int = 0
    mean_reproj_error: float | None = None
    error: str = ""
    detail: str = ""


@dataclass
class ColmapResult:
    ok: bool
    sparse_dir: Path | None = None
    registered_count: int = 0
    total_images: int = 0
    mean_reproj_error: float | None = None
    error: str = ""
    stage_error_code: str = ""


# ---------------------------------------------------------------------------
# Progress-parsing helpers
# ---------------------------------------------------------------------------

_RE_PROCESSED_FILE = re.compile(r"Processed file\s+\[?(\d+)/(\d+)\]?")
_RE_REGISTERING_IMAGE = re.compile(r"Registering image\s+(\d+)/(\d+)")
_RE_REGISTERED_OUT_OF = re.compile(r"Registered\s+(\d+)\s+images out of\s+(\d+)")
_RE_WARNING_ONLY = re.compile(
    r"Warning:\s+Only\s+(\d+)\s+out of\s+(\d+)\s+images registered"
)


def _parse_feature_progress(line: str) -> tuple[int, int] | None:
    """Return (N, M) from ``Processed file N/M`` or ``None``."""
    m = _RE_PROCESSED_FILE.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


def _parse_mapper_progress(line: str) -> tuple[int, int] | None:
    """Return (X, Y) from ``Registering image X/Y`` or ``None``."""
    m = _RE_REGISTERING_IMAGE.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


def _parse_mapper_final(line: str) -> tuple[int, int] | None:
    """Return (registered, total) from ``Registered X out of Y`` lines."""
    m = _RE_REGISTERED_OUT_OF.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = _RE_WARNING_ONLY.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


# ---------------------------------------------------------------------------
# Feature extractor
# ---------------------------------------------------------------------------

def run_feature_extractor(
    runner: CommandRunner,
    frames_dir: Path,
    db_path: Path,
    profile: dict,
) -> FeatureResult:
    """Run ``colmap feature_extractor`` and return a :class:`FeatureResult`.

    Progress is derived from the tool's ``Processed file N/M`` stdout lines.
    """
    camera_model = profile.get("camera_model", "SIMPLE_RADIAL")
    single_camera = int(profile.get("single_camera", 1))
    use_gpu = bool(profile.get("use_gpu", False))
    max_features = int(profile.get("max_features_per_image", 8192))

    cmd: list[str] = [
        "colmap",
        "feature_extractor",
        "--database_path",
        str(db_path),
        "--image_path",
        str(frames_dir),
        "--ImageReader.camera_model",
        str(camera_model),
        "--ImageReader.single_camera",
        str(single_camera),
        "--SiftExtraction.use_gpu",
        "1" if use_gpu else "0",
        "--SiftExtraction.max_num_features",
        str(max_features),
    ]

    last_n, last_m = 0, 0

    def _on_progress(chunk: str) -> None:
        nonlocal last_n, last_m
        parsed = _parse_feature_progress(chunk)
        if parsed:
            last_n, last_m = parsed

    runner._on_progress = _on_progress  # type: ignore[attr-defined]
    logger.info("feature_extractor start: %s", quote_argv(cmd))
    result = runner.run(cmd)
    runner._on_progress = None  # type: ignore[attr-defined]

    if not result.ok:
        logger.error("feature_extractor failed: %s", result.error)
        return FeatureResult(ok=False, total=last_m, extracted=last_n,
                             error=result.error or result.output[-2000:])

    # Use final stdout scan to confirm the totals.
    if last_m == 0:
        # Fallback: scan captured output for last match.
        for line in result.output.splitlines():
            parsed = _parse_feature_progress(line)
            if parsed:
                last_n, last_m = parsed

    logger.info("feature_extractor done: %d/%d", last_n, last_m)
    return FeatureResult(ok=True, total=last_m, extracted=last_n,
                         detail=f"{last_n}/{last_m}")


# ---------------------------------------------------------------------------
# Matcher
# ---------------------------------------------------------------------------

def run_matcher(
    runner: CommandRunner,
    db_path: Path,
    profile: dict,
) -> MatchResult:
    """Run exhaustive or sequential matcher.

    Exhaustive matching is indeterminate — there is no N/M counter on stdout.
    """
    matching = profile.get("matching", "exhaustive")
    use_gpu = bool(profile.get("use_gpu", False))
    num_threads = profile.get("num_threads")

    if matching == "sequential":
        cmd: list[str] = [
            "colmap",
            "sequential_matcher",
            "--database_path",
            str(db_path),
            "--SiftMatching.use_gpu",
            "1" if use_gpu else "0",
        ]
    else:
        cmd = [
            "colmap",
            "exhaustive_matcher",
            "--database_path",
            str(db_path),
            "--SiftMatching.use_gpu",
            "1" if use_gpu else "0",
        ]

    if num_threads is not None:
        cmd += ["--SiftMatching.num_threads", str(int(num_threads))]

    logger.info("matcher start [%s]: %s", matching, quote_argv(cmd))
    result = runner.run(cmd)

    if not result.ok:
        logger.error("matcher failed [%s]: %s", matching, result.error)
        return MatchResult(ok=False, error=result.error or result.output[-2000:])

    logger.info("matcher done [%s]", matching)
    return MatchResult(ok=True, detail=matching)


# ---------------------------------------------------------------------------
# Mapper
# ---------------------------------------------------------------------------

def run_mapper(
    runner: CommandRunner,
    frames_dir: Path,
    db_path: Path,
    sparse_out_dir: Path,
    profile: dict,
) -> MapResult:
    """Run ``colmap mapper`` and verify the sparse model output.

    Parses ``Registering image X/Y`` for progress and the final summary
    line for registered vs total counts.  After the process finishes the
    ``sparse/0/`` subdirectory is validated for the three required binary
    files and then read via :func:`read_sparse_model`.
    """
    cmd: list[str] = [
        "colmap",
        "mapper",
        "--database_path",
        str(db_path),
        "--image_path",
        str(frames_dir),
        "--output_path",
        str(sparse_out_dir),
    ]
    # COLMAP's mapper refuses a non-existent ``--output_path``; retries clear
    # the sparse dir between attempts, so recreate it before every run.
    sparse_out_dir.mkdir(parents=True, exist_ok=True)

    registered, total = 0, 0
    mean_reproj: float | None = None

    def _on_progress(chunk: str) -> None:
        nonlocal registered, total
        p = _parse_mapper_progress(chunk)
        if p:
            registered, total = p

    runner._on_progress = _on_progress  # type: ignore[attr-defined]
    logger.info("mapper start: %s", quote_argv(cmd))
    result = runner.run(cmd)
    runner._on_progress = None  # type: ignore[attr-defined]

    if not result.ok:
        logger.error("mapper failed: %s", result.error)
        return MapResult(ok=False, registered=registered, total=total,
                         error=result.error or result.output[-2000:])

    # Final pass: look for the summary line in stdout.
    for line in result.output.splitlines():
        final = _parse_mapper_final(line)
        if final:
            registered, total = final

    # Locate the sparse output directory. COLMAP's mapper writes
    # ``<output_path>/0/`` (one model), so ``sparse_out_dir`` must be the
    # parent that holds ``0/`` — the orchestrator passes ``<job>/colmap/sparse``
    # so the final model lands at ``<job>/colmap/sparse/0``.
    expected_sparse = sparse_out_dir / "0"
    if not expected_sparse.is_dir():
        # Some COLMAP versions omit ``0`` if zero images registered.
        logger.error("sparse output directory not found: %s", expected_sparse)
        return MapResult(ok=False, registered=registered, total=total,
                         error="COLMAP mapper 未生成 sparse/0 目录")

    required_bins = ("cameras.bin", "images.bin", "points3D.bin")
    missing = [b for b in required_bins if not (expected_sparse / b).exists()]
    if missing:
        return MapResult(ok=False, registered=registered, total=total,
                         error=f"sparse 模型缺少文件: {', '.join(missing)}")

    try:
        model = read_sparse_model(expected_sparse)
        registered = model.registered_image_count
        mean_reproj = model.mean_reprojection_error()
    except FileNotFoundError as exc:
        return MapResult(ok=False, registered=registered, total=total,
                         error=str(exc))

    detail = f"{registered}/{total}" if total else str(registered)
    logger.info("mapper done: %s", detail)
    return MapResult(ok=True, registered=registered, total=total,
                     mean_reproj_error=mean_reproj, detail=detail)


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def run_colmap_pipeline(
    runner: CommandRunner,
    frames_dir: Path,
    colmap_dir: Path,
    profile: dict,
) -> ColmapResult:
    """Run the three COLMAP stages sequentially and enforce the quality gate.

    ``colmap_dir`` is the working directory for this reconstruction; the
    database is written to ``colmap_dir/database.db`` and sparse output to
    ``colmap_dir/output/``.

    Returns a :class:`ColmapResult` with the path to the accepted sparse
    model directory.  Raises ``ValueError`` when the quality gate fails.
    """
    db_path = colmap_dir / "database.db"
    sparse_out = colmap_dir / "output"

    # Stage 1 — features
    feat = run_feature_extractor(runner, frames_dir, db_path, profile)
    if not feat.ok:
        return ColmapResult(ok=False, error=feat.error, stage_error_code="FEATURE_EXTRACTOR_FAILED")

    # Stage 2 — matching
    match = run_matcher(runner, db_path, profile)
    if not match.ok:
        return ColmapResult(ok=False, error=match.error, stage_error_code="MATCHER_FAILED")

    # Stage 3 — sparse mapping
    mapping = run_mapper(runner, frames_dir, db_path, sparse_out, profile)
    if not mapping.ok:
        return ColmapResult(ok=False, registered_count=mapping.registered,
                            total_images=mapping.total, error=mapping.error,
                            stage_error_code="MAPPER_FAILED")

    # Quality gate ----------------------------------------------------------
    sparse_dir = sparse_out / "0"
    total_images = mapping.total or feat.total
    registered_count = mapping.registered
    min_ratio = float(profile.get("min_registered_ratio", 0.6))
    min_count = int(profile.get("min_registered_images", 5))

    if total_images == 0:
        msg = "COLMAP mapper 未处理任何图片"
        logger.error("quality gate failed: %s", msg)
        raise ValueError(msg)

    ratio = registered_count / total_images
    if registered_count < min_count or ratio < min_ratio:
        msg = (
            f"COLMAP 注册率过低: {registered_count}/{total_images} "
            f"({ratio:.1%}) — 要求 >= {min_count} 张且 >= {min_ratio:.0%}"
        )
        logger.warning("quality gate failed: %s", msg)
        raise ValueError(msg)

    logger.info(
        "colmap pipeline OK: registered=%d total=%d mean_reproj=%.4f",
        registered_count,
        total_images,
        mapping.mean_reproj_error or 0.0,
    )
    return ColmapResult(
        ok=True,
        sparse_dir=sparse_dir,
        registered_count=registered_count,
        total_images=total_images,
        mean_reproj_error=mapping.mean_reproj_error,
    )

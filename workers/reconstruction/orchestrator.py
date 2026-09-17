"""Pipeline orchestrator — drives one reconstruction job through all stages (Phase 07).

The orchestrator is *reentrant*: it reads stage completion markers from
``stage-state/`` and resumes from the first incomplete stage. The three
Celery task entry points call the same :func:`run_pipeline` with different
``stage_range`` so the CPU-only stages, GPU training, and the CPU publish
phases can live on separate queues while sharing one job directory.

Progress and error reporting are delegated through injectable callbacks —
the orchestrator itself never opens a DB session except for the PUBLISHING
stage, where the spec explicitly requires committing the version through
:class:`app.services.publish_service.PublishService` (a session must be
passed in for that stage to run).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import struct
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from workers.reconstruction import colmap_pipeline, colmap_reader, convert_sog
from workers.reconstruction import extract_frames, probe, quality_gate
from workers.reconstruction.command_runner import CommandRunner, quote_argv
from workers.reconstruction.profiles import Profile, load_profile
from workers.reconstruction.progress import StageProgress
from workers.reconstruction.state_machine import (
    RECONSTRUCTION_STAGES,
    CompletionMarker,
    StageManager,
    param_hash,
    sha256_of_text,
)

logger = logging.getLogger("gsplatform.workers.orchestrator")

# Repository root — the training subprocess imports ``workers.*`` by module
# name, so we must re-inject PYTHONPATH (CommandRunner strips it by default).
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

__all__ = ["run_pipeline", "StageError", "detect_input_kind", "sniff_extension"]

# Progress / error callback contracts (injected by the Celery task):
#   on_progress(stage: str, pct: int)
#   on_error(stage: str, code: str, message: str, suggestion: str)
ProgressCallback = Callable[[str, int], None]
ErrorCallback = Callable[[str, str, str, str], None]


class StageError(Exception):
    """Stable, safe stage failure carrying an error_code + suggestion."""

    def __init__(
        self,
        stage: str,
        code: str,
        message: str,
        suggestion: str = "",
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.suggestion = suggestion


# ──────────────────────────────────────────────────────────────────────────────
# Input sniffing (upload.bin carries no extension — magic numbers decide)
# ──────────────────────────────────────────────────────────────────────────────
_MP4_BRAND_EXT = {
    b"isom": ".mp4",
    b"mp42": ".mp4",
    b"mp41": ".mp4",
    b"avc1": ".mp4",
    b"dash": ".mp4",
    b"qt  ": ".mov",
    b"M4V ": ".m4v",
    b"m4v ": ".m4v",
}


def sniff_extension(path: Path) -> str:
    """Return the most likely extension (.mp4/.mov/.mkv/.avi/.jpg/.png/.webp).

    Reads only the first 16 bytes; empty/unknown files fall back to ``.bin``.
    """
    try:
        with path.open("rb") as fh:
            head = fh.read(16)
    except OSError:
        return ".bin"
    if len(head) < 12:
        return ".bin"

    if head[4:8] == b"ftyp":
        brand = head[8:12]
        return _MP4_BRAND_EXT.get(brand, ".mp4")
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return ".mkv"
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return ".avi"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if head[:4] == b"\x89PNG":
        return ".png"
    return ".bin"


def detect_input_kind(path: Path) -> str:
    """Classify an input file as ``video`` or ``photos`` by magic bytes.

    Falls back to a cheap ffprobe check only when magic is ambiguous so a
    stream with an unusual container is still routed correctly.
    """
    ext = sniff_extension(path)
    if ext in probe.VIDEO_EXTS:
        return "video"
    if ext in probe.IMAGE_EXTS:
        return "photos"
    if ext == ".bin":
        # Ambiguous magic — ask ffprobe whether a video stream exists.
        runner = CommandRunner(cwd=path.parent, timeout=60)
        res = runner.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_type",
                "-of", "json",
                str(path),
            ]
        )
        if res.ok and '"codec_type": "video"' in res.output:
            return "video"
    return "photos"


# ──────────────────────────────────────────────────────────────────────────────
# Shared job-run context
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class JobContext:
    job_id: str
    profile_name: str
    storage_root: Path
    job_dir: Path
    upload_ids: list[str]
    profile: Profile
    manager: StageManager
    progress: StageProgress
    attempt: int
    scene_id: str | None
    is_cancelled: Callable[[], bool]
    celery_task: Any
    on_progress: ProgressCallback | None
    on_error: ErrorCallback | None
    session: Any  # SQLAlchemy session — required only for PUBLISHING

    # derived dirs
    input_dir: Path = field(init=False)
    frames_dir: Path = field(init=False)
    colmap_dir: Path = field(init=False)
    gsplat_dir: Path = field(init=False)
    streamed_dir: Path = field(init=False)
    logs_dir: Path = field(init=False)
    stage_state_dir: Path = field(init=False)

    # pipeline state (set by stage handlers)
    tool_versions: dict[str, str] = field(default_factory=dict)
    probe_result: probe.ProbeResult | None = None
    video_path: Path | None = None
    photo_dir: Path | None = None
    frame_count: int = 0
    output_ply: Path | None = None
    staged_sog: Path | None = None
    convert_result: Any = None
    version_id: str = ""

    def __post_init__(self) -> None:
        self.input_dir = self.job_dir / "input"
        self.frames_dir = self.job_dir / "frames"
        self.colmap_dir = self.job_dir / "colmap"
        self.gsplat_dir = self.job_dir / "gsplat"
        self.streamed_dir = self.job_dir / "streamed-sog"
        self.logs_dir = self.job_dir / "logs"
        self.stage_state_dir = self.job_dir / "stage-state"


# ──────────────────────────────────────────────────────────────────────────────
# Small helpers
# ──────────────────────────────────────────────────────────────────────────────
def _file_hash(path: Path) -> str:
    """SHA-256 of a file's content; stable ``MISSING`` marker when absent."""
    if not path.is_file():
        return sha256_of_text("MISSING")
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _tree_hash(directory: Path) -> str:
    """Deterministic hash of a directory's (relpath, size) manifest."""
    if not directory.is_dir():
        return sha256_of_text("MISSING-DIR")
    entries = []
    for p in sorted(directory.rglob("*")):
        if p.is_file():
            rel = p.relative_to(directory).as_posix()
            entries.append(f"{rel}:{p.stat().st_size}")
    return sha256_of_text("\n".join(entries))


def _sources_hash(ctx: JobContext) -> str:
    """Hash of the source staging uploads (stable across resume attempts)."""
    parts = []
    for uid in sorted(ctx.upload_ids):
        p = Path(ctx.storage_root) / "staging" / uid / "upload.bin"
        size = p.stat().st_size if p.exists() else -1
        parts.append(f"{uid}:{size}")
    return sha256_of_text("\n".join(parts))


def _section_params(ctx: JobContext, section_name: str) -> dict:
    """Section dict without a ``profile`` key (it collides with the explicit kwarg)."""
    return {k: v for k, v in ctx.profile.section(section_name).items() if k != "profile"}


def _hash_for_stage(ctx: JobContext, stage: str) -> tuple[str, str]:
    """Return (input_hash, param_hash) a stage's marker must match.

    Hashes are computed exclusively from *persistent* artifacts (source
    uploads, frames tree, sparse tree, PLY) so a resumed attempt derives
    identical values and correctly skips finished stages.  ``database.db``
    and ``streamed-sog/`` are outputs that mutate as stages run, so they are
    deliberately excluded.
    """
    name = ctx.profile_name
    if stage == "PROBING":
        return _sources_hash(ctx), param_hash(profile=name, version=ctx.profile.version)
    if stage == "EXTRACTING":
        return _tree_hash(ctx.input_dir), param_hash(profile=name, **_section_params(ctx, "extract"))
    if stage == "PRECHECK":
        ph = param_hash(
            profile=name,
            min_registered_images=int(ctx.profile.colmap().get("min_registered_images", 5)),
        )
        return _tree_hash(ctx.frames_dir), ph
    if stage in ("FEATURES", "MATCHING", "MAPPING"):
        # NB: database.db is the *output* of these stages and mutates as each
        # one runs, so it must not be part of the input hash — a resumed
        # attempt would otherwise mismatch every COLMAP-stage marker and re-run
        # finished stages (colmap's mapper refuses an existing sparse dir).
        return _tree_hash(ctx.frames_dir), param_hash(profile=name, **_section_params(ctx, "colmap"))
    if stage == "TRAINING":
        ih = _tree_hash(ctx.colmap_dir / "sparse") + "|" + _tree_hash(ctx.frames_dir)
        return ih, param_hash(profile=name, **_section_params(ctx, "gsplat"))
    if stage == "CONVERTING":
        ply = ctx.job_dir / "gsplat" / "final.ply"
        return _file_hash(ply), param_hash(profile=name, **_section_params(ctx, "convert"))
    if stage in ("VERIFYING", "PUBLISHING"):
        return _tree_hash(ctx.streamed_dir), param_hash(profile=name, **_section_params(ctx, "convert"))
    raise KeyError(f"unknown stage {stage!r}")


def _marker(ctx: JobContext, stage: str, output_hash: str) -> CompletionMarker:
    input_hash, ph = _hash_for_stage(ctx, stage)
    return CompletionMarker(
        stage=stage,
        input_hash=input_hash,
        param_hash=ph,
        tool_versions=ctx.tool_versions,
        output_hash=output_hash,
    )


def _append_log(ctx: JobContext, text: str) -> None:
    """Append a line to logs/pipeline.log, trimming the file when it overflows."""
    log_path = ctx.logs_dir / "pipeline.log"
    try:
        ctx.logs_dir.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(text + "\n")
        max_bytes = int(ctx.profile.resource().get("max_log_bytes", 2_097_152))
        if log_path.stat().st_size > max_bytes:
            lines = log_path.read_text(encoding="utf-8").splitlines()
            keep = lines[-max(1, len(lines) // 2):]
            log_path.write_text("\n".join(keep) + "\n", encoding="utf-8")
    except OSError:
        pass


def _report(ctx: JobContext, stage: str, pct: int) -> None:
    """Report stage progress through the injected callback + Celery state."""
    if ctx.on_progress is not None:
        try:
            ctx.on_progress(stage, pct)
        except Exception:  # noqa: BLE001 — a broken callback must not kill the pipeline
            logger.exception("on_progress callback failed (stage=%s)", stage)
    if ctx.celery_task is not None:
        try:
            ctx.celery_task.update_state(
                state="PROGRESS", meta={"stage": stage, "progress": pct}
            )
        except Exception:  # noqa: BLE001
            logger.exception("celery update_state failed (stage=%s)", stage)
    logger.info("[job %s] stage %s progress=%d", ctx.job_id, stage, pct)


def _report_error(ctx: JobContext, exc: StageError) -> None:
    if ctx.on_error is not None:
        try:
            ctx.on_error(exc.stage, exc.code, exc.message, exc.suggestion)
        except Exception:  # noqa: BLE001
            logger.exception("on_error callback failed (stage=%s)", exc.stage)
    if ctx.celery_task is not None:
        try:
            ctx.celery_task.update_state(
                state="FAILURE",
                meta={
                    "stage": exc.stage,
                    "error": exc.code,
                    "error_message": exc.message,
                    "suggestion": exc.suggestion,
                },
            )
        except Exception:  # noqa: BLE001
            pass


def _make_runner(
    ctx: JobContext, *, gpu: bool = False, on_progress: Any = None
) -> CommandRunner:
    """Build a CommandRunner with profile resource bounds for a stage family."""
    res = ctx.profile.resource()
    if gpu:
        timeout = int(res.get("gpu_time_s", 7200))
    else:
        timeout = int(res.get("cpu_time_s", 3600))
    env = {"PYTHONPATH": str(REPO_ROOT)} if gpu else None
    return CommandRunner(
        cwd=ctx.job_dir,
        env=env,
        timeout=timeout,
        is_cancelled=ctx.is_cancelled,
        on_progress=on_progress,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Stage handlers — each writes its own completion marker on success.
# ──────────────────────────────────────────────────────────────────────────────
def _classify_inputs(ctx: JobContext) -> None:
    """Re-derive video_path / photo_dir from ctx.input_dir when not yet set.

    Called when PROBING was skipped on resume and stage handlers downstream
    (EXTRACTING etc.) need to know whether the input is a video or photo set.
    """
    if ctx.video_path is not None or ctx.photo_dir is not None:
        return
    video = [p for p in ctx.input_dir.iterdir() if p.is_file() and p.suffix.lower() in probe.VIDEO_EXTS]
    if len(video) == 1:
        ctx.video_path = video[0]
    else:
        photos_dir = ctx.input_dir / "photos"
        if photos_dir.is_dir():
            ctx.photo_dir = photos_dir


def _derive_frame_count(ctx: JobContext) -> int:
    """Count frames in ctx.frames_dir from disk (for PRECHECK on resume)."""
    if ctx.frame_count > 0:
        return ctx.frame_count
    count = 0
    if ctx.frames_dir.is_dir():
        for p in ctx.frames_dir.iterdir():
            if p.is_file() and p.suffix.lower() in probe.IMAGE_EXTS:
                count += 1
    ctx.frame_count = count
    return count


def _rebuild_convert_state(ctx: JobContext) -> None:
    """Recover convert_result + version_id from the staged directory on resume.

    When CONVERTING was skipped on resume its handler never runs, so
    ctx.convert_result and ctx.version_id stay empty.  This reads the
    manifest/lod-meta/build-info that were written to streamed-sog and
    reconstructs a lightweight substitute.
    """
    if ctx.convert_result is not None and ctx.version_id:
        return
    staged = ctx.streamed_dir
    manifest_path = staged / "manifest.json"
    lod_meta_path = staged / "lod-meta.json"
    build_info_path = staged / "build-info.json"
    if not manifest_path.is_file():
        return

    import types

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry_bytes = lod_meta_path.stat().st_size if lod_meta_path.is_file() else 0
    source_sha256 = ""
    if build_info_path.is_file():
        try:
            bi = json.loads(build_info_path.read_text(encoding="utf-8"))
            source_sha256 = bi.get("sourceSha256", "")
        except (json.JSONDecodeError, OSError):
            pass

    if not ctx.version_id:
        marker = ctx.manager.read("CONVERTING")
        if marker is not None:
            ctx.version_id = marker.output_hash

    if ctx.convert_result is None:
        ctx.convert_result = types.SimpleNamespace(
            ok=True,
            version_id=ctx.version_id,
            entry_bytes=entry_bytes,
            source_sha256=source_sha256,
            manifest=manifest,
        )


def _stage_probing(ctx: JobContext) -> None:
    """Copy uploads into ``input/``, classify, and probe (video or photos)."""
    # 1. copy staged uploads into the job input dir
    if ctx.input_dir.exists():
        shutil.rmtree(ctx.input_dir, ignore_errors=True)
    ctx.input_dir.mkdir(parents=True, exist_ok=True)

    copies: list[tuple[Path, Path]] = []
    for uid in ctx.upload_ids:
        src = Path(ctx.storage_root) / "staging" / uid / "upload.bin"
        if not src.is_file():
            raise StageError(
                "PROBING", "NO_INPUT", "暂存输入文件缺失", "请重新上传素材。"
            )
        ext = sniff_extension(src)
        copies.append((src, ctx.input_dir / f"{uid}{ext}"))

    for src, dst in copies:
        shutil.copy2(src, dst)

    # 2. classify: one video file -> video; otherwise a photo set.
    # Keep the client's uploadIds order: it encodes the photo sequence
    # (capture order / orbit position). Sorting by the random upload-UUID
    # filenames would permute the sequence differently per job, which sends
    # COLMAP's mapper down divergent initial-pair paths and makes
    # registration count unreproducible.
    input_files = [d for _, d in copies]
    video_candidates = [f for f in input_files if sniff_extension(f) in probe.VIDEO_EXTS]
    if len(ctx.upload_ids) == 1 and video_candidates:
        ctx.video_path = video_candidates[0]
    elif len(ctx.upload_ids) == 1 and sniff_extension(input_files[0]) in probe.IMAGE_EXTS:
        ctx.video_path = None
    else:
        ctx.video_path = None

    # 3. probe
    runner = _make_runner(ctx)
    input_limits = ctx.profile.input_limits()
    probe_result: probe.ProbeResult
    if ctx.video_path is not None:
        probe_result = probe.probe_video(ctx.video_path, runner)
    else:
        photo_dir = ctx.input_dir / "photos"
        photo_dir.mkdir(parents=True, exist_ok=True)
        for i, f in enumerate(
            (p for p in input_files if sniff_extension(p) in probe.IMAGE_EXTS), 1
        ):
            dst = photo_dir / f"{i:04d}{sniff_extension(f)}"
            if not dst.exists():
                shutil.copy2(f, dst)
        ctx.photo_dir = photo_dir
        probe_result = probe.probe_photos(
            photo_dir, runner, max_count=int(input_limits.get("max_images", 300))
        )

    # 4. enforce profile input limits
    try:
        quality_gate.gate_probe(probe_result, input_limits)
    except quality_gate.GateError as exc:
        raise StageError("PROBING", exc.error_code, exc.error_message, exc.suggestion) from exc

    ctx.manager.write(_marker(ctx, "PROBING", "ok"))
    logger.info("[job %s] PROBING ok (kind=%s)", ctx.job_id, "video" if ctx.video_path else "photos")


def _stage_extracting(ctx: JobContext) -> None:
    """Extract frames from video (ffmpeg) or stage the photo set."""
    _classify_inputs(ctx)  # re-derive kind when PROBING was skipped on resume
    if ctx.video_path is not None:
        video_file = ctx.video_path
        total_seconds = None
        probe_result = None  # duration comes from a probe we re-run cheaply below
        # Re-probe for duration so EXTRACTING progress has a real denominator.
        runner = _make_runner(ctx)

        def _ffmpeg_progress(line: str) -> None:
            kv = extract_frames.parse_ffmpeg_progress_line(line)
            if not kv or total_seconds is None or total_seconds <= 0:
                return
            if "out_time_us" in kv:
                try:
                    elapsed = float(kv["out_time_us"]) / 1_000_000
                except (TypeError, ValueError):
                    return
                frac = min(1.0, elapsed / total_seconds)
                _report(ctx, "EXTRACTING", ctx.progress.advance("EXTRACTING", frac))

        try:
            probe_result = probe.probe_video(video_file, runner)
        except probe.ProbeError:
            probe_result = None
        total_seconds = probe_result.duration_s if probe_result else None

        runner = _make_runner(ctx, on_progress=_ffmpeg_progress)
        extract_result = extract_frames.extract_frames(
            video_path=video_file,
            frames_dir=ctx.frames_dir,
            runner=runner,
            profile=ctx.profile.extract(),
            total_seconds=total_seconds,
        )
        if not extract_result.ok:
            raise StageError(
                "EXTRACTING", "EXTRACT_FAILED", extract_result.error or "ffmpeg 抽帧失败",
                "请确认视频可解码且未损坏。",
            )
        try:
            quality_gate.gate_extract(
                extract_result, int(ctx.profile.extract().get("max_frames", 300))
            )
        except quality_gate.GateError as exc:
            raise StageError("EXTRACTING", exc.error_code, exc.error_message, exc.suggestion) from exc
        ctx.frame_count = extract_result.frame_count
    else:
        # photo set: copy from input/photos into frames/ with server names
        if ctx.photo_dir is None:
            raise StageError("EXTRACTING", "NO_PHOTOS", "没有可用的照片输入")
        ctx.frames_dir.mkdir(parents=True, exist_ok=True)
        photos = sorted(
            p for p in ctx.photo_dir.iterdir()
            if p.is_file() and p.suffix.lower() in probe.IMAGE_EXTS
        )
        for i, p in enumerate(photos, 1):
            dst = ctx.frames_dir / f"frame_{i:05d}{p.suffix.lower()}"
            if not dst.exists():
                shutil.copy2(p, dst)
        ctx.frame_count = len(photos)
        max_frames = int(ctx.profile.extract().get("max_frames", 300))
        if ctx.frame_count == 0:
            raise StageError("EXTRACTING", "NO_FRAMES", "没有生成任何帧")
        if ctx.frame_count > max_frames:
            raise StageError(
                "EXTRACTING", "TOO_MANY_FRAMES",
                f"照片数量 {ctx.frame_count} 超过上限 {max_frames}",
                "请减少照片数量或使用较低质量 profile。",
            )

    ctx.manager.write(_marker(ctx, "EXTRACTING", str(ctx.frame_count)))
    logger.info("[job %s] EXTRACTING ok (frames=%d)", ctx.job_id, ctx.frame_count)


def _stage_precheck(ctx: JobContext) -> None:
    """Fail fast when the frame count can never satisfy COLMAP registration."""
    _derive_frame_count(ctx)  # re-derive when EXTRACTING was skipped on resume
    min_images = int(ctx.profile.colmap().get("min_registered_images", 5))
    if ctx.frame_count < min_images:
        raise StageError(
            "PRECHECK", "TOO_FEW_FRAMES",
            f"可用帧/照片仅 {ctx.frame_count} 张，至少需要 {min_images} 张",
            "请提供更多照片或更长的视频片段。",
        )
    ctx.manager.write(_marker(ctx, "PRECHECK", str(ctx.frame_count)))
    logger.info("[job %s] PRECHECK ok (frames=%d)", ctx.job_id, ctx.frame_count)


def _stage_features(ctx: JobContext) -> None:
    runner = _make_runner(ctx)
    result = colmap_pipeline.run_feature_extractor(
        runner, ctx.frames_dir, ctx.colmap_dir / "database.db", ctx.profile.colmap()
    )
    if not result.ok:
        raise StageError(
            "FEATURES", "FEATURE_EXTRACTOR_FAILED",
            result.error or "COLMAP feature_extractor 失败",
            "请检查输入图像是否可读。",
        )
    ctx.manager.write(_marker(ctx, "FEATURES", f"{result.extracted}/{result.total}"))
    logger.info("[job %s] FEATURES ok (%s)", ctx.job_id, result.detail)


def _stage_matching(ctx: JobContext) -> None:
    runner = _make_runner(ctx)
    result = colmap_pipeline.run_matcher(
        runner, ctx.colmap_dir / "database.db", ctx.profile.colmap()
    )
    if not result.ok:
        raise StageError(
            "MATCHING", "MATCHER_FAILED",
            result.error or "COLMAP 匹配失败",
            "可尝试更换 matching 策略或检查图像重叠度。",
        )
    ctx.manager.write(_marker(ctx, "MATCHING", result.detail or "ok"))
    logger.info("[job %s] MATCHING ok", ctx.job_id)


def _pick_best_sparse_model(sparse_root: Path) -> Path | None:
    """Return the COLMAP model subdir with the most registered images.

    COLMAP's mapper writes one model per connected component to
    ``<output>/<n>/``. For smooth orbit video sequences the scene is often
    split across two models (e.g. ``0`` and ``1``); the reconstruction that
    passes the quality gate should be the *best* one, not necessarily
    ``<output>/0``. Reads each candidate's ``images.bin`` header to count
    registered images and picks the largest.
    """
    best: Path | None = None
    best_count = -1
    if not sparse_root.is_dir():
        return None
    for cand in sorted(sparse_root.iterdir()):
        if not cand.is_dir():
            continue
        images_bin = cand / "images.bin"
        if not images_bin.exists():
            continue
        try:
            with open(images_bin, "rb") as fh:
                count = struct.unpack("<Q", fh.read(8))[0]
        except (OSError, struct.error):
            continue
        if count > best_count:
            best_count = count
            best = cand
    return best


def _stage_mapping(ctx: JobContext) -> None:
    """Run COLMAP mapper, then retry matcher+mapper on low registration.

    COLMAP's exhaustive matcher builds randomized FLANN kd-trees, so a
    run occasionally draws a bad match set (e.g. 2/40 registered) that
    the identical input normally reproduces at 15-16/40. Retry up to
    ``mapping_max_attempts`` (default 3) times; each retry re-runs the
    matcher (new FLANN tree) and mapper (cleared sparse output) because
    COLMAP's mapper refuses to write into an existing sparse dir.
    """
    profile_colmap = ctx.profile.colmap()
    max_attempts = int(profile_colmap.get("mapping_max_attempts", 3))
    model: colmap_reader.SparseModel | None = None
    result: colmap_pipeline.MapResult | None = None
    gate_error: quality_gate.GateError | None = None

    for attempt in range(1, max_attempts + 1):
        runner = _make_runner(ctx)

        # COLMAP's exhaustive matcher builds randomized FLANN kd-trees, so a
        # run occasionally draws a bad match set (e.g. 2/40 registered) that
        # the identical input normally reproduces at 15-16/40. Re-run the
        # matcher on each attempt after the first (fresh FLANN draw) and
        # clear the sparse output first because the mapper refuses to write
        # into an existing sparse dir.
        if attempt > 1:
            # COLMAP's matcher skips pairs that already have a row, so the
            # retry must first clear the matches table for a fresh FLANN draw.
            colmap_pipeline.clear_colmap_matches(ctx.colmap_dir / "database.db")
            match = colmap_pipeline.run_matcher(
                runner, ctx.colmap_dir / "database.db", profile_colmap
            )
            if not match.ok:
                raise StageError(
                    "MATCHING", "MATCHER_FAILED",
                    match.error or "COLMAP 匹配失败",
                    "可尝试更换 matching 策略或检查图像重叠度。",
                )
            sparse_dir = ctx.colmap_dir / "sparse"
            if sparse_dir.exists():
                shutil.rmtree(sparse_dir, ignore_errors=True)

        result = colmap_pipeline.run_mapper(
            runner,
            ctx.frames_dir,
            ctx.colmap_dir / "database.db",
            ctx.colmap_dir / "sparse",  # COLMAP writes <out>/0 → we need <out>/sparse/0
            profile_colmap,
        )
        if not result.ok:
            raise StageError(
                "MAPPING", "MAPPER_FAILED",
                result.error or "COLMAP mapper 失败",
                "请检查图像质量或重叠度。",
            )
        model_dir = _pick_best_sparse_model(ctx.colmap_dir / "sparse")
        if model_dir is None:
            raise StageError("MAPPING", "NO_SPARSE_MODEL", "COLMAP mapper 未生成稀疏模型")
        try:
            model = colmap_reader.read_sparse_model(model_dir)
        except FileNotFoundError as exc:
            raise StageError("MAPPING", "SPARSE_MODEL_INCOMPLETE", str(exc)) from exc

        try:
            quality_gate.gate_colmap_registration(model, profile_colmap)
            gate_error = None
            break  # gate passed
        except quality_gate.GateError as exc:
            gate_error = exc
            logger.warning(
                "[job %s] MAPPING attempt %d/%d failed gate: %s (%d reg)",
                ctx.job_id, attempt, max_attempts, exc.error_message,
                model.registered_image_count,
            )
            if attempt == max_attempts:
                break

    assert model is not None and result is not None
    if gate_error is not None:
        registered = model.registered_image_count
        total = result.total or ctx.frame_count
        message = gate_error.error_message or f"仅注册 {registered}/{total} 张图像"
        raise StageError("MAPPING", gate_error.error_code, message, gate_error.suggestion)

    ctx.manager.write(
        _marker(ctx, "MAPPING", f"reg={model.registered_image_count}_pts={model.point_count}")
    )
    logger.info(
        "[job %s] MAPPING ok (registered=%d points=%d)",
        ctx.job_id, model.registered_image_count, model.point_count,
    )


_RE_GSITER = re.compile(r"GSITER\s+step=(\d+)\s+total=(\d+)(?:\s+loss=([0-9.eE+-]+))?")
_RE_GSITER_SHORT = re.compile(r"GSITER\s+(\d+)\s*/\s*(\d+)")


def _parse_gsiter(line: str) -> tuple[int, int] | None:
    """Parse a GSITER progress line → (step, total). None when not a GSITER line."""
    m = _RE_GSITER.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = _RE_GSITER_SHORT.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


def _stage_training(ctx: JobContext) -> None:
    """Invoke the gsplat training subprocess and stream real iteration progress."""
    gsplat_sec = ctx.profile.gsplat()
    iterations = int(gsplat_sec.get("iterations", 1200))
    ctx.output_ply = ctx.job_dir / "gsplat" / "final.ply"
    ctx.output_ply.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = ctx.gsplat_dir / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    sparse_dir = ctx.colmap_dir / "sparse" / "0"
    if not sparse_dir.is_dir():
        raise StageError("TRAINING", "NO_SPARSE_MODEL", "缺少 COLMAP 稀疏模型，无法训练")

    # params.json for resume + a safe invocation summary
    params = {
        "colmap_dir": str(sparse_dir),
        "images_dir": str(ctx.frames_dir),
        "output": str(ctx.output_ply),
        "checkpoint_dir": str(checkpoint_dir),
        "iterations": iterations,
        "sh_degree": int(gsplat_sec.get("sh_degree", 0)),
        "lr": float(gsplat_sec.get("lr", 0.01)),
        "downscale": int(gsplat_sec.get("downscale", 1)),
        "save_interval": int(gsplat_sec.get("save_interval", 200)),
        "random_init": bool(gsplat_sec.get("random_init", False)),
        "densify": bool(gsplat_sec.get("densify", True)),
        "seed": int(gsplat_sec.get("seed", 42)),
    }
    (ctx.gsplat_dir / "params.json").write_text(
        json.dumps(params, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    train_argv = [
        sys.executable, "-m", "workers.reconstruction.train_gsplat_script",
        "--colmap-dir", str(sparse_dir),
        "--images-dir", str(ctx.frames_dir),
        "--output", str(ctx.output_ply),
        "--iterations", str(iterations),
        "--sh-degree", str(params["sh_degree"]),
        "--lr", str(params["lr"]),
        "--save-interval", str(params["save_interval"]),
        "--seed", str(params["seed"]),
        "--device", "cuda:0",
        "--checkpoint-dir", str(checkpoint_dir),
        "--min-splats", "100",
    ]
    if params["random_init"]:
        train_argv.append("--random-init")
    if not params["densify"]:
        train_argv.append("--no-densify")
    logger.info("[job %s] TRAINING invocation: %s", ctx.job_id, quote_argv(train_argv))
    _append_log(ctx, f"TRAINING: {quote_argv(train_argv)}")

    def _training_progress(line: str) -> None:
        parsed = _parse_gsiter(line)
        if parsed is None:
            return
        step, total = parsed
        total = total if total > 0 else iterations
        frac = min(1.0, step / max(total, 1))
        _report(ctx, "TRAINING", ctx.progress.advance("TRAINING", frac))

    runner = _make_runner(ctx, gpu=True, on_progress=_training_progress)
    result = runner.run(train_argv)
    if not result.ok:
        if result.cancelled:
            raise StageError("TRAINING", "CANCELLED", "训练已被取消")
        output = result.output.lower()
        if "out of memory" in output or "cuda out of memory" in output:
            raise StageError(
                "TRAINING", "TRAINING_OOM",
                "GPU 显存不足，训练失败",
                "请降低 profile 质量或等待 GPU 空闲后重试。",
            )
        raise StageError(
            "TRAINING", "TRAINING_FAILED",
            result.error or result.output[-1000:] or "gsplat 训练失败",
            "请检查 GPU 环境或降低训练参数后重试。",
        )

    if not ctx.output_ply.is_file():
        raise StageError("TRAINING", "NO_OUTPUT_PLY", "训练完成但未生成 PLY 文件")
    try:
        quality_gate.gate_training_output(ctx.output_ply, min_splats=100)
    except quality_gate.GateError as exc:
        raise StageError("TRAINING", exc.error_code, exc.error_message, exc.suggestion) from exc

    ctx.manager.write(
        _marker(ctx, "TRAINING", f"{ctx.output_ply.stat().st_size}bytes")
    )
    logger.info("[job %s] TRAINING ok (%d bytes)", ctx.job_id, ctx.output_ply.stat().st_size)


def _stage_converting(ctx: JobContext) -> None:
    # Derive PLY from job_dir — may be unset when TRAINING was skipped on resume.
    if ctx.output_ply is None:
        ctx.output_ply = ctx.job_dir / "gsplat" / "final.ply"
    if not ctx.output_ply.is_file():
        raise StageError("CONVERTING", "NO_TRAINED_PLY", "缺少训练产物，无法转换")
    if not ctx.scene_id:
        raise StageError("CONVERTING", "CONVERT_FAILED", "缺少 scene_id，无法生成版本目录")

    if ctx.streamed_dir.exists():
        shutil.rmtree(ctx.streamed_dir, ignore_errors=True)
    ctx.streamed_dir.mkdir(parents=True, exist_ok=True)
    convert_sec = ctx.profile.convert()

    cr = convert_sog.convert_ply_to_streamed_sog(
        ctx.output_ply,
        ctx.streamed_dir,
        scene_id=ctx.scene_id,
        profile_name=str(convert_sec.get("profile", "balanced")),
        gpu=str(convert_sec.get("gpu", "cpu")),
    )
    if not cr.ok:
        raise StageError("CONVERTING", "CONVERT_FAILED", cr.reason or "Streamed SOG 转换失败")
    ctx.convert_result = cr
    ctx.version_id = cr.version_id
    ctx.manager.write(_marker(ctx, "CONVERTING", cr.version_id))
    logger.info("[job %s] CONVERTING ok (version=%s)", ctx.job_id, cr.version_id)


def _stage_verifying(ctx: JobContext) -> None:
    if ctx.streamed_dir is None or not ctx.streamed_dir.is_dir():
        raise StageError("VERIFYING", "MISSING_MANIFEST", "版本目录不存在，无法校验")
    try:
        quality_gate.gate_publish(ctx.streamed_dir)
    except quality_gate.GateError as exc:
        raise StageError("VERIFYING", exc.error_code, exc.error_message, exc.suggestion) from exc
    ctx.manager.write(_marker(ctx, "VERIFYING", "ok"))
    logger.info("[job %s] VERIFYING ok", ctx.job_id)


def _stage_publishing(ctx: JobContext) -> None:
    """Atomically promote the staged SOG and commit the version via PublishService."""
    if ctx.session is None:
        raise StageError(
            "PUBLISHING", "PUBLISH_FAILED", "缺少 DB session，无法发布版本"
        )
    if not ctx.scene_id:
        raise StageError("PUBLISHING", "PUBLISH_FAILED", "缺少 scene_id，无法发布版本")
    if ctx.streamed_dir is None or not ctx.streamed_dir.is_dir():
        raise StageError("PUBLISHING", "PUBLISH_FAILED", "版本目录缺失，无法发布")
    _rebuild_convert_state(ctx)  # recover result+version when CONVERTING was skipped
    if not ctx.version_id or ctx.convert_result is None:
        raise StageError("PUBLISHING", "PUBLISH_FAILED", "缺少转换结果，无法发布")

    from app.services.publish_service import PublishService
    from app.storage import LocalDiskStorage

    scene_id = uuid.UUID(str(ctx.scene_id))
    storage = LocalDiskStorage(str(ctx.storage_root))
    svc = PublishService(ctx.session, storage)

    # Copy the staged tree under published/<scene>/.staging, then promote it
    # atomically into the immutable version dir (same filesystem).  We copy
    # rather than move: streamed-sog/ is the deliverable of CONVERTING and the
    # marker source for VERIFYING/PUBLISHING, so it must survive this stage
    # for a later resume to skip correctly.
    scene_dir = Path(ctx.storage_root) / "published" / str(scene_id)
    scene_dir.mkdir(parents=True, exist_ok=True)
    publish_staging = scene_dir / ".staging"
    if publish_staging.exists():
        shutil.rmtree(publish_staging, ignore_errors=True)
    shutil.copytree(ctx.streamed_dir, publish_staging)

    cr = ctx.convert_result
    try:
        svc.promote_staging_to_version(
            scene_id, ctx.version_id, f"published/{scene_id}/.staging"
        )
        svc.commit_version(
            scene_id=scene_id,
            version_id=ctx.version_id,
            manifest=cr.manifest or {},
            entry_bytes=cr.entry_bytes,
            entry_url=f"versions/{ctx.version_id}/lod-meta.json",
            counts=(cr.manifest or {}).get("stream", {}).get("counts", [0, 0, 0]),
            source_sha256=cr.source_sha256,
        )
    except Exception as exc:  # noqa: BLE001 — surface a stable publish error
        logger.exception("[job %s] PUBLISHING failed", ctx.job_id)
        raise StageError(
            "PUBLISHING", "PUBLISH_FAILED", f"版本发布失败: {exc}"
        ) from exc

    ctx.manager.write(_marker(ctx, "PUBLISHING", ctx.version_id))
    logger.info("[job %s] PUBLISHING ok (scene=%s version=%s)", ctx.job_id, scene_id, ctx.version_id)


STAGE_HANDLERS: dict[str, Callable[[JobContext], None]] = {
    "PROBING": _stage_probing,
    "EXTRACTING": _stage_extracting,
    "PRECHECK": _stage_precheck,
    "FEATURES": _stage_features,
    "MATCHING": _stage_matching,
    "MAPPING": _stage_mapping,
    "TRAINING": _stage_training,
    "CONVERTING": _stage_converting,
    "VERIFYING": _stage_verifying,
    "PUBLISHING": _stage_publishing,
}


# ──────────────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────────────
def run_pipeline(
    job_id: str,
    storage_root: str,
    upload_ids: list[str],
    profile_name: str,
    stage_range: tuple[str, str],
    *,
    celery_task: Any = None,
    is_cancelled: Callable[[], bool] | None = None,
    attempt: int = 1,
    scene_id: str | None = None,
    on_progress: ProgressCallback | None = None,
    on_error: ErrorCallback | None = None,
    session: Any = None,
) -> dict:
    """Run the reconstruction pipeline for *job_id* over ``stage_range``.

    The range is inclusive over :data:`RECONSTRUCTION_STAGES`, e.g.
    ``("PROBING", "MAPPING")``, ``("TRAINING", "TRAINING")`` or
    ``("CONVERTING", "SUCCEEDED")``.

    Returns a dict:
        success: {"ok": True, "version_id", "stage": "SUCCEEDED", "progress": 100}
        failure: {"ok": False, "error", "error_message", "suggestion", "stage", "progress"}

    The function is reentrant: completed stages are skipped when their marker
    matches the current input + parameter hashes. It never raises or calls
    ``sys.exit`` — every path returns a dict.
    """
    cancel_check = is_cancelled or (lambda: False)
    job_dir = Path(storage_root) / "jobs" / job_id / f"attempt-{attempt}"
    profile = load_profile(profile_name)
    ctx = JobContext(
        job_id=job_id,
        profile_name=profile_name,
        storage_root=Path(storage_root),
        job_dir=job_dir,
        upload_ids=list(upload_ids),
        profile=profile,
        manager=StageManager(job_dir / "stage-state"),
        progress=StageProgress(profile.stage_specs),
        attempt=attempt,
        scene_id=scene_id,
        is_cancelled=cancel_check,
        celery_task=celery_task,
        on_progress=on_progress,
        on_error=on_error,
        session=session,
    )
    ctx.tool_versions = _tool_versions()

    for d in (
        ctx.input_dir, ctx.frames_dir, ctx.colmap_dir / "sparse",
        ctx.gsplat_dir / "checkpoints", ctx.streamed_dir,
        ctx.logs_dir, ctx.stage_state_dir,
    ):
        d.mkdir(parents=True, exist_ok=True)

    logger.info(
        "[job %s] run_pipeline attempt=%d range=%s..%s dir=%s",
        job_id, attempt, stage_range[0], stage_range[1], ctx.job_dir,
    )
    _append_log(ctx, f"start attempt={attempt} profile={profile_name}")

    try:
        start_idx = RECONSTRUCTION_STAGES.index(stage_range[0])
        end_idx = RECONSTRUCTION_STAGES.index(stage_range[1])
    except ValueError:
        return {"ok": False, "error": "BAD_STAGE_RANGE", "error_message": f"非法阶段范围: {stage_range}"}

    if start_idx > end_idx:
        return {"ok": False, "error": "BAD_STAGE_RANGE", "error_message": f"阶段范围逆序: {stage_range}"}

    stages = RECONSTRUCTION_STAGES[start_idx : end_idx + 1]
    last_done: str | None = None

    for stage in stages:
        if stage == "SUCCEEDED":
            continue  # terminal marker, handled after the loop
        if cancel_check():
            logger.info("[job %s] cancellation requested at %s", job_id, stage)
            return {
                "ok": False, "error": "CANCELLED", "error_message": "任务已取消",
                "stage": stage, "progress": ctx.progress.at_start(stage),
            }

        handler = STAGE_HANDLERS[stage]
        try:
            input_hash, ph = _hash_for_stage(ctx, stage)
            if ctx.manager.is_complete(stage, input_hash=input_hash, param_hash=ph):
                logger.info("[job %s] stage %s skipped (marker match)", job_id, stage)
                _append_log(ctx, f"stage {stage} skipped (marker)")
                _report(ctx, stage, ctx.progress.advance(stage, 1.0))
                last_done = stage
                continue

            _report(ctx, stage, ctx.progress.at_start(stage))
            _append_log(ctx, f"stage {stage} start")
            handler(ctx)
            _append_log(ctx, f"stage {stage} done")
            _report(ctx, stage, ctx.progress.advance(stage, 1.0))
            last_done = stage
        except StageError as exc:
            _append_log(ctx, f"stage {exc.stage} FAILED: {exc.code} {exc.message}")
            _report_error(ctx, exc)
            logger.warning("[job %s] stage %s failed: %s (%s)", job_id, exc.stage, exc.code, exc.message)
            return {
                "ok": False,
                "error": exc.code,
                "error_message": exc.message,
                "suggestion": exc.suggestion,
                "stage": exc.stage,
                "progress": ctx.progress.at_start(exc.stage),
            }
        except Exception:  # noqa: BLE001 — wrap unknown failures
            logger.exception("[job %s] stage %s crashed", job_id, stage)
            safe = "重建流程内部错误，请查看日志或稍后重试"
            return {
                "ok": False, "error": "INTERNAL_ERROR", "error_message": safe,
                "stage": stage, "progress": ctx.progress.at_start(stage),
            }

    # success — report the terminal state.
    # If PUBLISHING was skipped on resume, ctx.version_id is empty: recover it
    # from the CONVERTING marker (which stores the version_id as output_hash).
    if last_done == "PUBLISHING":
        if not ctx.version_id:
            marker = ctx.manager.read("CONVERTING")
            if marker is not None:
                ctx.version_id = marker.output_hash
        _report(ctx, "SUCCEEDED", 100)
        return {"ok": True, "version_id": ctx.version_id, "stage": "SUCCEEDED", "progress": 100}

    if not last_done:
        # Nothing in this range needed to run (e.g. only SUCCEEDED) — done.
        return {"ok": True, "stage": "SUCCEEDED", "progress": 100, "job_dir": str(ctx.job_dir), "attempt": attempt}

    final_pct = ctx.progress.advance(last_done, 1.0)
    return {
        "ok": True,
        "stage": last_done,
        "progress": final_pct,
        "job_dir": str(ctx.job_dir),
        "attempt": attempt,
    }


def _tool_versions() -> dict[str, str]:
    """Best-effort tool version snapshot for completion markers."""
    try:
        from workers.reconstruction.capabilities import check_capabilities

        report = check_capabilities(with_gpu_probe=False)
        return {k: str(v or "present") for k, v in report.tools.items()}
    except Exception:  # noqa: BLE001 — markers tolerate missing versions
        return {"ffmpeg": "present", "colmap": "present", "gsplat": "present"}

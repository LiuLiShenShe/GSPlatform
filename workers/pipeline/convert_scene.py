"""Pipeline — streamed-SOG conversion (Phase 06).

Converts an uploaded source asset into a streamed-SOG **staging tree**:

  PLY / SOG / SPLAT → decimate → stack → manifest + build-info + checksums

The conversion writes ONLY into a caller-supplied staging directory; the
caller (``publish_scene`` task) verifies that tree and atomically renames it
into the immutable version dir before touching the database.

The locked CLI path is resolved from the same ``node_modules`` location used
by ``scripts/build_streamed_sog.sh``. ``convert_to_streamed_sog`` is a pure
function of source path → staging dir; callers handle DB state.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import shutil
import signal
import subprocess
import tempfile
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from workers.pipeline.validate_scene import _sha256_of, _validate_ply_header

logger = logging.getLogger("gsplatform.workers.convert")

# ──────────────────────────────────────────────────────────────────────────────
# Locked CLI location (same as scripts/build_streamed_sog.sh).
# ──────────────────────────────────────────────────────────────────────────────
_ROOT = Path(__file__).resolve().parent.parent.parent
_NODE_BIN = (
    _ROOT
    / "node_modules"
    / ".pnpm"
    / "@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0"
    / "node_modules"
    / "@playcanvas"
    / "splat-transform"
    / "bin"
    / "cli.mjs"
)

# Pinned CLI identity — part of the conversion recipe (see ``conversion_recipe``):
# a different splat-transform can emit different bytes for the same input, so it
# must be able to move the asset version.
_TOOL_VERSION = "3.3.3"

# Bump when the recipe *semantics* change (not for timeout/env tuning): it is
# mixed into every asset_version so old and new outputs stay independently
# addressable and immutable.
_RECIPE_VERSION = "2"

# LOD 0 is the ORIGINAL source (PlayCanvas: "LOD 0 = highest detail"); the two
# reduced tiers are decimated from it.  Ratios are expressed as CLI percent
# strings so the value that reaches the command line is the value recorded here.
_LOD_RATIOS: tuple[str, ...] = ("30%", "10%")

# Profiles: (--lod-chunk-count K, --lod-chunk-extent world units).
# NOTE: the online CLI reference also documents ``--lod-chunk-min``, but the
# version this repo pins (3.3.3) rejects it -- its ``--help`` lists only the
# two options below, and passing the third fails with
# ERR_PARSE_ARGS_UNKNOWN_OPTION. Do not add it without bumping the pinned CLI.
_PROFILES: dict[str, tuple[int, int]] = {
    "balanced": (64, 32),
    "eco": (512, 32),
    "quality": (64, 16),
}

# FIX-UPLOAD-01 §5: the *declared upload format* (validated upstream) maps to
# the file extension splat-transform's input sniffing needs.  The upload is
# staged server-side as ``upload.bin`` (random, server-owned name), so the
# extension must come from this allowlist — never from a client filename /
# ``upload.bin``'s ``.bin`` suffix.  ``zip`` uploads are streamed-SOG-ish
# containers that splat-transform reads as ``.sog``.
_FORMAT_TO_EXT: dict[str, str] = {
    "ply": ".ply",
    "splat": ".splat",
    "sog": ".sog",
    "zip": ".sog",
}


def conversion_recipe(
    profile: str,
    chunk_count: int,
    chunk_extent: int,
    gpu: str = "cpu",
) -> dict:
    """The set of inputs that determine the produced bytes.

    Deliberately EXCLUDES operational settings (per-CLI timeout, logging,
    staging paths, GPU adapter index) so an operator tuning
    ``GS_CONVERT_TIMEOUT_S`` never forces a new immutable asset version.
    """
    return {
        "recipeVersion": _RECIPE_VERSION,
        "tool": "splat-transform",
        "toolVersion": _TOOL_VERSION,
        "profile": profile,
        "lodRatios": ["100%", *_LOD_RATIOS],
        "lodOrder": [0, 1, 2],
        "lodChunkCount": chunk_count,
        "lodChunkExtent": chunk_extent,
        "lodChunkMin": None,
        "shIterations": 10,
        "computeBackend": "cpu" if gpu == "cpu" else "webgpu",
    }


def _canonical(obj: dict) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _source_recipe(source_path: Path, profile: str, gpu: str) -> dict:
    recipe = conversion_recipe(profile, *_PROFILES[profile], gpu)
    if not zipfile.is_zipfile(source_path):
        return recipe
    with zipfile.ZipFile(source_path) as archive:
        if "lod-meta.json" not in archive.namelist():
            return recipe
        with archive.open("lod-meta.json") as entry:
            metadata = json.loads(entry.read(16 * 1024 * 1024))
    return {
        "recipeVersion": _RECIPE_VERSION,
        "mode": "streamed-passthrough",
        "tool": None,
        "toolVersion": metadata.get("asset", {}).get("generator"),
        "profile": "passthrough",
        "lodRatios": None,
        "lodCounts": metadata.get("counts"),
        "lodChunkCount": metadata.get("asset", {}).get("chunkGaussians", 0) / 1024
        or None,
        "lodChunkExtent": metadata.get("asset", {}).get("chunkExtent"),
        "lodChunkMin": None,
    }


def version_id_for(source_sha256: str, recipe: dict) -> str:
    """Deterministic asset version id for (source bytes, conversion recipe).

    Previously this was ``source_sha256[:12]``, which meant re-converting an
    unchanged PLY under different parameters produced the SAME id — and so
    collided with the already-published immutable version dir (ConflictError in
    ``promote_staging_to_version`` / silent row reuse in ``commit_version``).
    Hashing the recipe in alongside the source makes each recipe its own
    version while keeping the 12-hex-char shape the storage layout and URLs
    already expect.  The pristine source hash is still recorded separately on
    SceneVersion.sha256 for provenance.
    """
    digest = hashlib.sha256(
        f"{source_sha256}\n{_canonical(recipe)}".encode()
    ).hexdigest()
    return digest[:12]


def _env_int(name: str, default: int) -> int:
    """Read an integer env var with a sane fallback (negative → default).

    Kept here (rather than in app.core.config.Settings) because
    ``convert_scene`` is importable without the API package; env-var driven
    keeps operators able to size timeouts to hardware without a code deploy.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("invalid %s=%r; using default %d", name, raw, default)
        return default
    return value if value > 0 else default


# Per-CLI-step timeout.  The SOG stack scales super-linearly with gaussian
# count: a 13M-gaussian scene needs more than the historical 1200s for the
# stack step alone. Operators size this via GS_CONVERT_TIMEOUT_S; the default
# (2h) covers very large PLY while still bounding a hung subprocess.
_TIMEOUT = _env_int("GS_CONVERT_TIMEOUT_S", 7200)

# Default compute device passed to splat-transform's ``-g`` ("cpu" or a GPU
# adapter index like "0").  Decimation is CPU-bound either way; SOG compression
# and GPU voxelization use the adapter when provided.  Resolved at call time
# (never a def-time default) so operators can switch without a worker restart
# of the module import.
_DEFAULT_GPU = os.environ.get("GS_CONVERT_GPU", "cpu")


@dataclass(frozen=True)
class ConvertResult:
    ok: bool
    version_id: str = ""
    entry_bytes: int = 0
    source_sha256: str = ""
    manifest: dict | None = None
    reason: str = ""
    recipe: dict | None = None
    stage_durations: dict | None = None
    staging_dir: Path | None = None


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────
def _run(cmd: list[str], cwd: Path | None = None, timeout: int | None = None) -> str:
    # Resolve the timeout at call time (not as a def-time default) so a
    # runtime/env change to ``_TIMEOUT`` actually takes effect.
    if timeout is None:
        timeout = _env_int("GS_CONVERT_TIMEOUT_S", _TIMEOUT)
    output_file = (cwd / "cli.log").open("a+b") if cwd else tempfile.TemporaryFile()
    with output_file as output:
        process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            returncode = process.wait(timeout=timeout)
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            logger.exception("CLI interrupted; child group reaped")
            raise
        output.flush()
        output.seek(0, os.SEEK_END)
        output.seek(max(0, output.tell() - 65536))
        tail = output.read().decode("utf-8", errors="replace")
    logger.info("CLI exit=%s", returncode)
    if returncode != 0:
        raise RuntimeError(f"命令失败 (rc={returncode}): {tail}")
    return tail


def _read_counts(lod_meta: Path) -> list[int]:
    """Read per-LOD gaussian counts from the lod-meta.json container."""
    try:
        meta = json.loads(lod_meta.read_text(encoding="utf-8"))
        counts = meta.get("counts", [0, 0, 0])
        return [int(c) for c in counts]
    except Exception:
        return [0, 0, 0]


def _ply_vertex_count(path: Path) -> int:
    """Vertex count straight out of a binary PLY header (no data read).

    Recorded in build-info so the report can compare the source gaussian count
    against the LOD0 count instead of trusting the CLI argument string.
    """
    try:
        with path.open("rb") as fh:
            for _ in range(256):
                line = fh.readline()
                if not line:
                    break
                if line.startswith(b"element vertex"):
                    return int(line.split()[2])
                if line.strip() == b"end_header":
                    break
    except (OSError, ValueError, IndexError):
        logger.warning("Cannot read Gaussian count from PLY header")
    return 0


def _marker_for(target: Path) -> Path:
    return target.with_name(target.name + ".done.json")


def _complete_gaussian_count(target: Path) -> int:
    if _validate_ply_header(target) is not None:
        raise ValueError("Invalid Gaussian PLY header")
    count = _ply_vertex_count(target)
    types = {
        "char": 1,
        "uchar": 1,
        "int8": 1,
        "uint8": 1,
        "short": 2,
        "ushort": 2,
        "int16": 2,
        "uint16": 2,
        "int": 4,
        "uint": 4,
        "int32": 4,
        "uint32": 4,
        "float": 4,
        "float32": 4,
        "double": 8,
        "float64": 8,
    }
    with target.open("rb") as source:
        stride = 0
        binary = False
        vertex = False
        for _ in range(256):
            line = source.readline(1024).decode("ascii").strip()
            if line.startswith("format binary_"):
                binary = True
            if line.startswith("element"):
                vertex = line.startswith("element vertex")
            if vertex and line.startswith("property"):
                property_type = line.split()[1]
                if property_type not in types:
                    raise ValueError("Unsupported variable-stride Gaussian PLY")
                stride += types[property_type]
            if line == "end_header":
                break
        else:
            raise ValueError("PLY header exceeds integrity limit")
        if binary and target.stat().st_size < source.tell() + count * stride:
            raise ValueError("Truncated Gaussian PLY payload")
    return count


def _reusable_decimation(
    target: Path, *, ratio: str, source_sha256: str, recipe_key: str
) -> bool:
    """True only when *target* is a COMPLETE decimation of THIS source+recipe.

    The previous implementation kept no marker at all, so "the file exists"
    was the only signal available -- which cannot distinguish a finished
    decimation from one the CLI was still writing (or a half-written file from
    a kill).  We therefore require a marker written only after the CLI exits 0,
    plus a byte-size match AND a full re-hash of the output.
    """
    marker = _marker_for(target)
    try:
        m = json.loads(marker.read_text(encoding="utf-8"))
    except Exception:
        return False
    if (
        m.get("ratio") != ratio
        or m.get("sourceSha256") != source_sha256
        or m.get("recipeKey") != recipe_key
    ):
        return False
    if not target.is_file() or target.stat().st_size != m.get("bytes"):
        return False
    try:
        return (
            m.get("gaussianCount", 0) > 0
            and _complete_gaussian_count(target) == m["gaussianCount"]
            and _sha256_of(target) == m.get("sha256")
        )
    except (OSError, ValueError, UnicodeError):
        return False


def _mark_decimation(
    target: Path, *, ratio: str, source_sha256: str, recipe_key: str
) -> None:
    count = _complete_gaussian_count(target)
    if count <= 0 or _validate_ply_header(target) is not None:
        raise ValueError("Decimation did not produce a valid Gaussian PLY")
    marker = _marker_for(target)
    temporary = marker.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "ratio": ratio,
                "sourceSha256": source_sha256,
                "recipeKey": recipe_key,
                "bytes": target.stat().st_size,
                "sha256": _sha256_of(target),
                "gaussianCount": count,
            }
        ),
        encoding="utf-8",
    )
    temporary.replace(marker)


def _write_metadata(
    staging: Path,
    *,
    scene_id: str,
    ver: str,
    source_name: str,
    source_sha256: str,
    source_gaussian_count: int,
    entry_bytes: int,
    entry_sha256: str,
    has_poster: bool,
    recipe: dict,
    gpu: str,
    stage_durations: dict,
    total_duration: float,
    stage_records: dict | None = None,
    max_workers: int | None = None,
) -> dict:
    """Write manifest.json / build-info.json / checksums.sha256 into staging.

    Every field records what actually ran (PART G): the old version hardcoded
    profile/chunk/gpu regardless of the real command line, so the report
    contradicted the artifact it described.
    """
    counts = _read_counts(staging / "lod-meta.json")
    poster_url = f"versions/{ver}/poster.webp" if has_poster else None
    gaussian_total = sum(counts) if counts else 0

    manifest = {
        "schemaVersion": 1,
        "sceneId": scene_id,
        "assetVersion": ver,
        "format": "streamed-sog",
        "sourceSha256": source_sha256,
        "conversionRecipeVersion": recipe.get("recipeVersion"),
        "conversionRecipe": recipe,
        "stream": {
            "entryUrl": f"versions/{ver}/lod-meta.json",
            "byteLength": entry_bytes,
            "sha256": entry_sha256,
            "transport": "range",
            "lodLevels": len(counts),
            "counts": counts,
        },
        "poster": {"url": poster_url, "width": 1600, "height": 900}
        if poster_url
        else None,
        "camera": {"position": [0, 1.2, 3.5], "target": [0, 0.8, 0], "fov": 55},
    }
    (staging / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (staging / "build-info.json").write_text(
        json.dumps(
            {
                "tool": recipe.get("tool"),
                "toolVersion": recipe.get("toolVersion", _TOOL_VERSION),
                "sourceFile": source_name,
                "sourceSha256": source_sha256,
                "sourceGaussianCount": source_gaussian_count,
                "gaussianTotal": gaussian_total,
                "conversionRecipeVersion": recipe.get("recipeVersion"),
                "conversionRecipe": recipe,
                "profile": recipe.get("profile"),
                "lodRatios": recipe.get("lodRatios"),
                "lodLevels": len(counts),
                "lodCounts": counts,
                "lodChunkCount": recipe.get("lodChunkCount"),
                "lodChunkExtent": recipe.get("lodChunkExtent"),
                "chunkCountTarget": recipe.get("lodChunkCount"),
                "chunkExtent": recipe.get("lodChunkExtent"),
                "chunkMin": recipe.get("lodChunkMin"),
                "gpuDevice": gpu if recipe.get("tool") else None,
                "maxWorkers": max_workers,
                "stageDurations": stage_durations,
                "stages": stage_records or {},
                "totalDuration": round(total_duration, 3),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    checksums_lines = []
    for file in sorted(staging.rglob("*")):
        if file.is_file() and file.name != "checksums.sha256":
            rel = file.relative_to(staging).as_posix()
            checksums_lines.append(f"{_sha256_of(file)}  {rel}")
    (staging / "checksums.sha256").write_text(
        "\n".join(checksums_lines) + "\n", encoding="utf-8"
    )
    return manifest


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────
def _convert_to_streamed_sog(
    source_path: Path,
    staging_dir: Path,
    *,
    scene_id: str,
    profile: str = "balanced",
    gpu: str | None = None,
    source_format: str | None = None,
    source_sha256: str = "",
    on_stage: Callable | None = None,
    recipe_override: dict | None = None,
) -> ConvertResult:
    """Convert *source_path* into a streamed-SOG tree inside *staging_dir*.

    ``gpu`` is the device passed to splat-transform's ``-g`` ("cpu" or a GPU
    adapter index).  ``None`` resolves to ``GS_CONVERT_GPU`` at call time
    (default "cpu"); explicit pass-through from callers wins.

    ``source_format`` is the validated declared upload format (from the
    ``UploadSession``). When given, the internal copy splat-transform receives is
    named from ``_FORMAT_TO_EXT`` (the real source extension), so a PLY staged
    as ``upload.bin`` is converted as ``raw-input.ply``. When ``None``, the
    source path's own suffix / magic sniffing is used (backwards-compatible for
    direct-path callers such as the reconstruction pipeline).

    ``staging_dir`` must be a fresh, empty directory (created if missing).
    Writes manifest.json / build-info.json / checksums.sha256 and returns a
    :class:`ConvertResult`; the caller owns verifying + atomic publish.
    """
    started = time.monotonic()
    stage_durations: dict[str, float] = {}
    stage_records: dict[str, dict] = {}
    source_sha256 = source_sha256 or _sha256_of(source_path)
    if gpu is None:
        gpu = _DEFAULT_GPU
    chunk_count, chunk_extent = _PROFILES.get(profile, _PROFILES["balanced"])
    recipe = recipe_override or conversion_recipe(
        profile, chunk_count, chunk_extent, gpu
    )
    recipe_key = _canonical(recipe)
    ver = version_id_for(source_sha256, recipe)

    # The staging dir handed in is a ROOT: the real, version-scoped staging dir
    # lives under it.  Two concurrent publishes of the same scene previously
    # shared ``published/<scene>/.staging`` and each one rmtree'd the other's
    # partial output on entry; scoping by version makes concurrent runs
    # disjoint and still matches PublishService.begin()'s key layout.
    staging_root = staging_dir
    staging_dir = staging_root / ver
    if staging_dir.exists():
        shutil.rmtree(staging_dir, ignore_errors=True)
    staging_dir.mkdir(parents=True, exist_ok=True)
    workdir = staging_root.parent / f".workdir-{ver}"

    def stage_begin(name: str) -> tuple[float, str]:
        timestamp = datetime.now(timezone.utc).isoformat()
        logger.info("stage=%s state=RUNNING startedAt=%s", name, timestamp)
        if on_stage:
            on_stage(name, "RUNNING", {"startedAt": timestamp})
        return time.monotonic(), timestamp

    def stage_end(
        name: str, beginning: tuple[float, str], state: str = "SUCCEEDED"
    ) -> None:
        elapsed = round(time.monotonic() - beginning[0], 3)
        stage_durations[name] = elapsed
        record = {
            "startedAt": beginning[1],
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "elapsedSeconds": elapsed,
            "status": state,
        }
        stage_records[name] = record
        journal = workdir / "stages.json"
        journal.parent.mkdir(parents=True, exist_ok=True)
        journal.write_text(json.dumps(stage_records, indent=2))
        logger.info("stage=%s %s", name, json.dumps(record))
        if on_stage:
            on_stage(name, state, record)

    copying = stage_begin("COPYING")

    # ── stage 0: give splat-transform a file with a supported extension ─────
    # The staged upload is ``upload.bin`` (server-side random name); splat-transform
    # detects input format by extension. Copy + rename into the workdir using the
    # REAL source extension (from the validated declared format when available)
    # so conversion succeeds. The declared format maps through a fixed allowlist
    # so a hostile/odd string can never be interpolated into the filename.
    if source_format is not None:
        _EXT_FROM_MAGIC = _FORMAT_TO_EXT.get(source_format, ".bin")
    else:
        _EXT_FROM_MAGIC = source_path.suffix.lower() or ".sog"
        if source_path.suffix.lower() not in {
            ".ply",
            ".sog",
            ".spz",
            ".splat",
            ".ksplat",
            ".lcc",
            ".lcc2",
            ".gz",
        }:
            # SOG container = a zip whose root contains meta.json (raw) or
            # lod-meta.json (already streamed). Neither is a supported CLI input
            # extension, so treat as .sog.
            try:
                import zipfile

                with zipfile.ZipFile(source_path) as z:
                    names = {n.split("/")[0] for n in z.namelist()}
                if "meta.json" in names or "lod-meta.json" in names:
                    _EXT_FROM_MAGIC = ".sog"
            except Exception:
                _EXT_FROM_MAGIC = ".bin"

    workdir.mkdir(parents=True, exist_ok=True)
    raw_input = workdir / f"raw-input{_EXT_FROM_MAGIC}"
    if raw_input.exists():
        raw_input.unlink()
    if _EXT_FROM_MAGIC == ".ply":
        try:
            os.link(source_path, raw_input)
            logger.info("Using source PLY as LOD0 via hard link: %s", raw_input)
        except OSError:
            shutil.copy2(source_path, raw_input)
    else:
        shutil.copy2(source_path, raw_input)
    stage_end("COPYING", copying)

    # ── detect already-streamed source (zip containing lod-meta.json) ────────
    try:
        from workers.pipeline.validate_scene import safe_unpack_zip

        safe_unpack_zip(
            source_path, staging_dir, expected_size=source_path.stat().st_size
        )
        if (staging_dir / "lod-meta.json").exists():
            entry_bytes = (staging_dir / "lod-meta.json").stat().st_size
            entry_sha256 = _sha256_of(staging_dir / "lod-meta.json")
            passthrough_counts = _read_counts(staging_dir / "lod-meta.json")
            manifest = _write_metadata(
                staging_dir,
                scene_id=scene_id,
                ver=ver,
                source_name=source_path.name,
                source_sha256=source_sha256,
                # A pre-built streamed upload carries its own gaussian set; the
                # source PLY header does not apply.
                source_gaussian_count=passthrough_counts[0]
                if passthrough_counts
                else 0,
                entry_bytes=entry_bytes,
                entry_sha256=entry_sha256,
                has_poster=(staging_dir / "poster.webp").exists(),
                recipe=recipe,
                gpu=gpu,
                stage_durations=stage_durations,
                total_duration=time.monotonic() - started,
                stage_records=stage_records,
                max_workers=None,
            )
            shutil.rmtree(workdir, ignore_errors=True)
            return ConvertResult(
                True,
                version_id=ver,
                entry_bytes=entry_bytes,
                source_sha256=source_sha256,
                manifest=manifest,
                recipe=recipe,
                stage_durations=stage_durations,
                staging_dir=staging_dir,
            )
    except Exception as exc:
        logger.info("Source is not a pre-built streamed zip; converting. (%s)", exc)
        shutil.rmtree(staging_dir, ignore_errors=True)
        staging_dir.mkdir(parents=True, exist_ok=True)

    # ── stage 1: decimate the reduced LOD tiers ───────────────────────────────
    # LOD ordering (PlayCanvas spec: "LOD 0 = highest detail"):
    #   LOD 0 = the ORIGINAL, validated source PLY (no decimation; the old code
    #           spent a full 100% decimation pass to produce a byte-identical
    #           copy plus an extra 3.2 GB of disk traffic for a 13M scene).
    #   LOD 1 = source decimated to 30%
    #   LOD 2 = source decimated to 10%
    # The old order (10%→LOD0, 30%→LOD1, 100%→LOD2) was exactly backwards.
    lod1, lod2 = workdir / "lod1.ply", workdir / "lod2.ply"
    # The pinned CLI lives in node_modules; a pre-built streamed-zip passthrough
    # (returned above) never needs it, but any real conversion does. Check here,
    # not at the top of the function, so passthrough stays CLI-free.
    if not _NODE_BIN.exists():
        return ConvertResult(
            False,
            source_sha256=source_sha256,
            reason=f"splat-transform CLI 不可执行: {_NODE_BIN}",
            recipe=recipe,
        )
    # Decimation is a pure function of (source bytes, ratio): a marker-verified
    # file from an earlier failed attempt is safe to inherit instead of
    # re-running (see _reusable_decimation for the exact checks).
    t0 = time.monotonic()
    try:
        decimate_jobs = [
            (lod1, _LOD_RATIOS[0]),
            (lod2, _LOD_RATIOS[1]),
        ]
        # splat-transform 3.3.3 requires every lod-meta.json LOD input to be a
        # PLY ("local PLY input(s)"), so a .splat/.spz/... source cannot be
        # tagged directly as LOD 0 and must first be re-encoded to PLY.  For a
        # PLY upload -- the dominant case, and the one this optimisation exists
        # for -- the validated original IS LOD 0 and the redundant full-detail
        # pass disappears entirely.
        lod0 = raw_input
        if _EXT_FROM_MAGIC != ".ply":
            lod0 = workdir / "lod0.ply"
            if not _reusable_decimation(
                lod0,
                ratio="100%",
                source_sha256=source_sha256,
                recipe_key=recipe_key,
            ):
                _marker_for(lod0).unlink(missing_ok=True)
                _run(
                    [
                        str(_NODE_BIN),
                        "-g",
                        gpu,
                        str(raw_input),
                        "--decimate",
                        "100%",
                        str(lod0),
                        "--overwrite",
                        "--no-tty",
                        "--max-workers",
                        "0",
                    ],
                    cwd=workdir,
                )
                _mark_decimation(
                    lod0,
                    ratio="100%",
                    source_sha256=source_sha256,
                    recipe_key=recipe_key,
                )
            stage_durations["recode_to_ply"] = round(time.monotonic() - t0, 3)
        for target, ratio in decimate_jobs:
            name = "DECIMATE_LOD1" if target == lod1 else "DECIMATE_LOD2"
            beginning = stage_begin(name)
            if _reusable_decimation(
                target,
                ratio=ratio,
                source_sha256=source_sha256,
                recipe_key=recipe_key,
            ):
                logger.info("复用已验证的 %s (%s)", target.name, ratio)
                stage_end(name, beginning, "REUSED")
                continue
            _marker_for(target).unlink(missing_ok=True)
            _run(
                [
                    str(_NODE_BIN),
                    "-g",
                    gpu,
                    str(raw_input),
                    "--decimate",
                    ratio,
                    str(target),
                    "--overwrite",
                    "--no-tty",
                    "--max-workers",
                    "0",
                ],
                cwd=workdir,
            )
            _mark_decimation(
                target,
                ratio=ratio,
                source_sha256=source_sha256,
                recipe_key=recipe_key,
            )
            stage_end(name, beginning)
    except Exception as exc:
        if "name" in locals() and "beginning" in locals():
            stage_end(name, beginning, "FAILED")
        # Keep the workdir: whichever tier completed before the failure carries
        # a valid marker and will be inherited by the retry.
        return ConvertResult(
            False,
            source_sha256=source_sha256,
            reason=f"LOD decimate 失败: {exc}",
            recipe=recipe,
        )

    # ── stage 2: stack into lod-meta.json ─────────────────────────────────────
    entry = staging_dir / "lod-meta.json"
    stack_start = stage_begin("STACK")
    try:
        _run(
            [
                str(_NODE_BIN),
                "-g",
                gpu,
                str(lod0),
                "--tag-lod",
                "0",
                str(lod1),
                "--tag-lod",
                "1",
                str(lod2),
                "--tag-lod",
                "2",
                str(entry),
                "--lod-chunk-count",
                str(chunk_count),
                "--lod-chunk-extent",
                str(chunk_extent),
                "--sh-iterations",
                str(recipe["shIterations"]),
                "--overwrite",
                "--no-tty",
                "--max-workers",
                "0",
            ],
            cwd=workdir,
        )
    except Exception as exc:
        stage_end("STACK", stack_start, "FAILED")
        # The partial staging tree is unusable, but the workdir holds DECIMATED
        # intermediates that took tens of minutes to produce -- keep them so a
        # retry can inherit them (the marker check decides whether each file is
        # actually trustworthy).
        shutil.rmtree(staging_dir, ignore_errors=True)
        return ConvertResult(
            False,
            source_sha256=source_sha256,
            reason=f"lod-meta.json stack 失败: {exc}",
            recipe=recipe,
        )
    stage_end("STACK", stack_start)

    entry_bytes = entry.stat().st_size
    entry_sha256 = _sha256_of(entry)

    # ── stage 3: poster (best-effort, 90s timeout) ────────────────────────────
    poster = staging_dir / "poster.webp"
    poster_start = stage_begin("POSTER")
    poster_status = "SUCCEEDED"
    try:
        _run(
            [
                str(_NODE_BIN),
                "-g",
                gpu,
                str(raw_input),
                str(poster),
                "--no-tty",
                "--max-workers",
                "0",
            ],
            timeout=90,
            cwd=workdir,
        )
    except Exception as exc:
        logger.info("Poster render failed (non-fatal): %s", exc)
        poster.unlink(missing_ok=True)
        poster_status = "SKIPPED"
    stage_end("POSTER", poster_start, poster_status)

    # ── stage 4: metadata ─────────────────────────────────────────────────────
    total_duration = time.monotonic() - started
    manifest = _write_metadata(
        staging_dir,
        scene_id=scene_id,
        ver=ver,
        source_name=source_path.name,
        source_sha256=source_sha256,
        source_gaussian_count=_ply_vertex_count(lod0),
        entry_bytes=entry_bytes,
        entry_sha256=entry_sha256,
        has_poster=poster.exists(),
        recipe=recipe,
        gpu=gpu,
        stage_durations=stage_durations,
        total_duration=total_duration,
        stage_records=stage_records,
        max_workers=0,
    )
    return ConvertResult(
        True,
        version_id=ver,
        entry_bytes=entry_bytes,
        source_sha256=source_sha256,
        manifest=manifest,
        recipe=recipe,
        stage_durations=stage_durations,
        staging_dir=staging_dir,
    )


def convert_to_streamed_sog(
    source_path: Path,
    staging_dir: Path,
    *,
    scene_id: str,
    profile: str = "balanced",
    gpu: str | None = None,
    source_format: str | None = None,
    on_stage: Callable | None = None,
) -> ConvertResult:
    """Convert under an exclusive source/recipe lock; preserve valid intermediate files."""
    if profile not in _PROFILES:
        return ConvertResult(False, reason=f"不支持的转换 profile: {profile}")
    if source_format is not None and source_format not in _FORMAT_TO_EXT:
        return ConvertResult(False, reason="不支持的转换格式")
    source_sha256 = _sha256_of(source_path)
    gpu = gpu if gpu is not None else os.environ.get("GS_CONVERT_GPU", _DEFAULT_GPU)
    recipe = _source_recipe(source_path, profile, gpu)
    version = version_id_for(source_sha256, recipe)
    lock_dir = staging_dir.parent / ".conversion-locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    with (lock_dir / f"{version}.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return ConvertResult(
                False, source_sha256=source_sha256, reason="同源同配方转换正在运行"
            )
        existing = staging_dir.parent / "versions" / version
        if existing.is_dir():
            from workers.pipeline.verify_publish import verify_published_version

            verified = verify_published_version(existing)
            manifest = verified["manifest"]
            if (
                manifest.get("sourceSha256") != source_sha256
                or manifest.get("conversionRecipe") != recipe
            ):
                return ConvertResult(
                    False,
                    source_sha256=source_sha256,
                    reason="已发布版本与转换配方不匹配",
                )
            return ConvertResult(
                True,
                version_id=version,
                entry_bytes=verified["entry_bytes"],
                source_sha256=source_sha256,
                manifest=manifest,
                recipe=recipe,
                stage_durations={},
                staging_dir=existing,
            )
        return _convert_to_streamed_sog(
            source_path,
            staging_dir,
            scene_id=scene_id,
            profile=profile,
            gpu=gpu,
            source_format=source_format,
            source_sha256=source_sha256,
            on_stage=on_stage,
            recipe_override=recipe,
        )

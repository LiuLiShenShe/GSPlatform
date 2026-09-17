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

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from workers.pipeline.validate_scene import _sha256_of

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

# Profiles: (chunk-count, chunk-extent).
_PROFILES: dict[str, tuple[int, int]] = {
    "balanced": (4, 8),
    "eco": (8, 16),
    "quality": (2, 4),
}

_TIMEOUT = 1200  # seconds — generous for large PLY files on CPU.


@dataclass(frozen=True)
class ConvertResult:
    ok: bool
    version_id: str = ""
    entry_bytes: int = 0
    source_sha256: str = ""
    manifest: dict | None = None
    reason: str = ""


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────
def _run(cmd: list[str], cwd: Path | None = None, timeout: int = _TIMEOUT) -> str:
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"命令失败 (rc={result.returncode}): {cmd}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout


def _read_counts(lod_meta: Path) -> list[int]:
    """Read per-LOD gaussian counts from the lod-meta.json container."""
    try:
        meta = json.loads(lod_meta.read_text(encoding="utf-8"))
        counts = meta.get("counts", [0, 0, 0])
        return [int(c) for c in counts]
    except Exception:
        return [0, 0, 0]


def _write_metadata(
    staging: Path,
    *,
    scene_id: str,
    ver: str,
    source_name: str,
    source_sha256: str,
    entry_bytes: int,
    entry_sha256: str,
    has_poster: bool,
) -> dict:
    """Write manifest.json / build-info.json / checksums.sha256 into staging."""
    counts = _read_counts(staging / "lod-meta.json")
    poster_url = f"versions/{ver}/poster.webp" if has_poster else None

    manifest = {
        "schemaVersion": 1,
        "sceneId": scene_id,
        "assetVersion": ver,
        "format": "streamed-sog",
        "stream": {
            "entryUrl": f"versions/{ver}/lod-meta.json",
            "byteLength": entry_bytes,
            "sha256": entry_sha256,
            "transport": "range",
            "lodLevels": len(counts),
            "counts": counts,
        },
        "poster": {"url": poster_url, "width": 1600, "height": 900} if poster_url else None,
        "camera": {"position": [0, 1.2, 3.5], "target": [0, 0.8, 0], "fov": 55},
    }
    (staging / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (staging / "build-info.json").write_text(
        json.dumps(
            {
                "tool": "splat-transform",
                "toolVersion": "3.3.3",
                "sourceFile": source_name,
                "sourceSha256": source_sha256,
                "profile": "balanced",
                "lodChunkCount": 4,
                "lodChunkExtent": 8,
                "lodLevels": len(counts),
                "counts": counts,
                "gpu": "cpu",
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
def convert_to_streamed_sog(
    source_path: Path,
    staging_dir: Path,
    *,
    scene_id: str,
    profile: str = "balanced",
    gpu: str = "cpu",
) -> ConvertResult:
    """Convert *source_path* into a streamed-SOG tree inside *staging_dir*.

    ``staging_dir`` must be a fresh, empty directory (created if missing).
    Writes manifest.json / build-info.json / checksums.sha256 and returns a
    :class:`ConvertResult`; the caller owns verifying + atomic publish.
    """
    if not _NODE_BIN.exists():
        return ConvertResult(False, reason=f"splat-transform CLI 不可执行: {_NODE_BIN}")

    source_sha256 = _sha256_of(source_path)
    ver = source_sha256[:12]
    # Re-run safety: clear any leftover staging tree from a previous failed
    # attempt before writing the new version.
    if staging_dir.exists():
        shutil.rmtree(staging_dir, ignore_errors=True)
    staging_dir.mkdir(parents=True, exist_ok=True)
    workdir = staging_dir.parent / f".workdir-{ver}"

    # ── stage 0: give splat-transform a file with a supported extension ─────
    # The staged upload is stored as ``upload.bin`` (server-side random name);
    # splat-transform detects input format by extension. Copy + rename into the
    # workdir using the real source extension so conversion succeeds.
    _EXT_FROM_MAGIC = source_path.suffix.lower() or ".sog"
    if source_path.suffix.lower() not in {
        ".ply", ".sog", ".spz", ".splat", ".ksplat", ".lcc", ".lcc2", ".gz",
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
    shutil.copy2(source_path, raw_input)

    # ── detect already-streamed source (zip containing lod-meta.json) ────────
    try:
        from workers.pipeline.validate_scene import safe_unpack_zip

        safe_unpack_zip(
            source_path, staging_dir, expected_size=source_path.stat().st_size
        )
        if (staging_dir / "lod-meta.json").exists():
            entry_bytes = (staging_dir / "lod-meta.json").stat().st_size
            entry_sha256 = _sha256_of(staging_dir / "lod-meta.json")
            manifest = _write_metadata(
                staging_dir,
                scene_id=scene_id,
                ver=ver,
                source_name=source_path.name,
                source_sha256=source_sha256,
                entry_bytes=entry_bytes,
                entry_sha256=entry_sha256,
                has_poster=(staging_dir / "poster.webp").exists(),
            )
            shutil.rmtree(workdir, ignore_errors=True)
            return ConvertResult(
                True,
                version_id=ver,
                entry_bytes=entry_bytes,
                source_sha256=source_sha256,
                manifest=manifest,
            )
    except Exception as exc:
        logger.info("Source is not a pre-built streamed zip; converting. (%s)", exc)
        shutil.rmtree(staging_dir, ignore_errors=True)
        staging_dir.mkdir(parents=True, exist_ok=True)

    # ── stage 1: decimate LOD tiers ──────────────────────────────────────────
    low, med, high = workdir / "low.ply", workdir / "med.ply", workdir / "high.ply"
    try:
        _run([str(_NODE_BIN), "-g", gpu, str(raw_input), "--decimate", "10%", str(low), "--overwrite", "--tty"])
        _run([str(_NODE_BIN), "-g", gpu, str(raw_input), "--decimate", "30%", str(med), "--overwrite", "--tty"])
        _run([str(_NODE_BIN), "-g", gpu, str(raw_input), "--decimate", "100%", str(high), "--overwrite", "--tty"])
    except Exception as exc:
        shutil.rmtree(workdir, ignore_errors=True)
        return ConvertResult(False, source_sha256=source_sha256, reason=f"LOD decimate 失败: {exc}")

    # ── stage 2: stack into lod-meta.json ─────────────────────────────────────
    chunk_count, chunk_extent = _PROFILES.get(profile, _PROFILES["balanced"])
    entry = staging_dir / "lod-meta.json"
    try:
        _run([
            str(_NODE_BIN), "-g", gpu,
            str(low), "--tag-lod", "0",
            str(med), "--tag-lod", "1",
            str(high), "--tag-lod", "2",
            str(entry),
            "--lod-chunk-count", str(chunk_count),
            "--lod-chunk-extent", str(chunk_extent),
            "--overwrite", "--tty",
        ])
    except Exception as exc:
        shutil.rmtree(staging_dir, ignore_errors=True)
        shutil.rmtree(workdir, ignore_errors=True)
        return ConvertResult(False, source_sha256=source_sha256, reason=f"lod-meta.json stack 失败: {exc}")

    entry_bytes = entry.stat().st_size
    entry_sha256 = _sha256_of(entry)

    # ── stage 3: poster (best-effort, 90s timeout) ────────────────────────────
    poster = staging_dir / "poster.webp"
    try:
        _run(
            [str(_NODE_BIN), "-g", gpu, str(raw_input), str(poster), "--tty"],
            timeout=90,
        )
    except Exception as exc:
        logger.info("Poster render failed (non-fatal): %s", exc)
        poster.unlink(missing_ok=True)

    # ── stage 4: metadata ─────────────────────────────────────────────────────
    manifest = _write_metadata(
        staging_dir,
        scene_id=scene_id,
        ver=ver,
        source_name=source_path.name,
        source_sha256=source_sha256,
        entry_bytes=entry_bytes,
        entry_sha256=entry_sha256,
        has_poster=poster.exists(),
    )
    shutil.rmtree(workdir, ignore_errors=True)
    return ConvertResult(
        True,
        version_id=ver,
        entry_bytes=entry_bytes,
        source_sha256=source_sha256,
        manifest=manifest,
    )
"""Finite measured conversion profiles and unchanged recipe-v2 identity."""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

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



@dataclass(frozen=True)
class ResolvedConversionPolicy:
    source_format: str | None
    profile: str
    gpu: str
    recipe: dict
    output_format: str = "streamed-sog"


def resolve_conversion_policy(source: Path, *, profile: str, source_format: str | None,
                              gpu: str) -> ResolvedConversionPolicy:
    if profile not in _PROFILES:
        raise ValueError(f"不支持的转换 profile: {profile}")
    if source_format is not None and source_format not in _FORMAT_TO_EXT:
        raise ValueError("不支持的转换格式")
    if gpu != "cpu" and not re.fullmatch(r"[0-9]+", gpu):
        raise ValueError("GPU selector must be cpu or a non-negative adapter index")
    return ResolvedConversionPolicy(source_format, profile, gpu, _source_recipe(source, profile, gpu))

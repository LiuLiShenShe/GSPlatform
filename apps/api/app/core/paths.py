"""Shared filesystem roots (FIX-05 P1-7).

Single source of truth for locating the repository root and the scene asset
roots.  Services must use these helpers instead of ``Path(__file__).parents[N]``
(the depth changes when files move) or ``Path.cwd()`` (the value changes when
the caller's working directory changes).
"""

from __future__ import annotations

from pathlib import Path

#: Marker file that identifies the repository root (git-ignored trees live
#: directly under it, e.g. ``scenes/``).
_REPO_MARKER = "pnpm-workspace.yaml"


def get_repo_root() -> Path:
    """Return the repository root — the directory holding ``pnpm-workspace.yaml``.

    Walked upward from this module's own file so the result never depends on
    the caller's working directory.  Falls back to a hard upper bound only if
    the marker is somehow absent (never reached in this repo).
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / _REPO_MARKER).is_file():
            return parent
    return here.parents[4]


def get_scene_origin_root() -> Path:
    """Dev/test scene-origin root (the ``scenes/`` tree next to the repo root).

    Production sets ``Settings.scene_origin_root`` explicitly; this helper
    backs the dev default and mirrors the API's ``storage_root`` default.
    """
    return get_repo_root() / "scenes"


def get_scene_storage_root(storage_root: str) -> Path:
    """Normalise a configured storage root to an absolute ``Path``.

    ``storage_root`` is the base for ``<storage>/published/<scene-id>/...``
    (scene-specific published roots) and ``<storage>/staging`` etc.
    """
    return Path(storage_root).expanduser().resolve()

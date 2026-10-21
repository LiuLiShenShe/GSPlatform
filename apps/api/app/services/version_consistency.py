"""DB ↔ filesystem consistency for scene version pointers (GS-NEXT-12 §B).

PostgreSQL and the scene-origin tree are **not** one transaction.  Version
activation deliberately writes the filesystem entry first and only then moves
``scenes.current_version_id`` (see ``scene_versions``), which rules out the
dangerous "DB says B, entry still serves A" state.  Two residual windows
remain and must be *detectable*, not guessed at:

* a process crash between the alias swap and the DB commit leaves the alias
  pointing at the new version while the DB still points at the old one;
* a manually damaged / missing origin tree, or a half-copied version
  directory, makes the entry unusable even though the DB looks healthy.

This module provides a repeatable, read-only-by-default check plus a **safe**
repair:

* repair only re-points the mutable ``current`` alias (and the
  ``versions/<ver>`` link) at the version the DB already designates;
* it never deletes, rewrites or replaces an immutable version directory, its
  manifest, or its assets;
* when the target version's bytes are missing it refuses and reports
  ``manual_intervention_required``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.scene import Scene, SceneVersion
from app.services.publish_service import (
    bridge_scene_origin,
    scene_origin_slug_dir,
    verify_scene_origin_alias,
)
from app.services.scene_versions import version_entry_name, version_physical_dir

#: Scene statuses whose current-version entry is expected to be servable.
_SERVABLE_STATUSES = ("PUBLISHED", "READY")


@dataclass
class SceneConsistency:
    scene_id: str
    slug: str
    status: str
    current_version_id: str | None
    asset_version: str | None
    problems: list[str] = field(default_factory=list)
    repairable: list[str] = field(default_factory=list)
    repaired: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def as_dict(self) -> dict[str, object]:
        return {
            "sceneId": self.scene_id,
            "slug": self.slug,
            "status": self.status,
            "currentVersionId": self.current_version_id,
            "assetVersion": self.asset_version,
            "ok": self.ok,
            "problems": self.problems,
            "repairable": self.repairable,
            "repaired": self.repaired,
            "notes": self.notes,
        }


def check_scene(session: Session, scene: Scene) -> SceneConsistency:
    """Inspect one scene without writing anything."""
    current_id = scene.current_version_id
    result = SceneConsistency(
        scene_id=str(scene.id),
        slug=scene.slug,
        status=scene.status,
        current_version_id=str(current_id) if current_id else None,
        asset_version=None,
    )

    if current_id is None:
        if scene.status in _SERVABLE_STATUSES:
            result.problems.append("current_version_missing")
        return result

    version = session.get(SceneVersion, current_id)
    if version is None or version.scene_id != scene.id:
        result.problems.append("current_version_row_missing")
        return result
    result.asset_version = version.asset_version

    # 1) Immutable bytes.
    directory = version_physical_dir(scene, version.asset_version)
    if directory is None:
        result.problems.append("version_directory_missing")
    else:
        entry = version_entry_name(version)
        if entry is None:
            result.problems.append("version_entry_unknown")
        elif not (directory / entry).is_file():
            result.problems.append("version_entry_missing")
        manifest_file = directory / "manifest.json"
        if not manifest_file.is_file():
            result.problems.append("version_manifest_missing")
        else:
            import json

            try:
                payload = json.loads(manifest_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                result.problems.append("version_manifest_unreadable")
            else:
                if not isinstance(payload, dict):
                    result.problems.append("version_manifest_unreadable")
                else:
                    if payload.get("assetVersion") not in (None, version.asset_version):
                        result.problems.append("version_manifest_asset_version_mismatch")
                    if payload.get("format") not in (None, version.format):
                        result.problems.append("version_manifest_format_mismatch")

    # 2) Scene-origin entry (only when this deployment maintains one).
    slug_dir = scene_origin_slug_dir(scene)
    if slug_dir is not None and slug_dir.parent.is_dir():
        if not slug_dir.is_dir():
            result.problems.append("scene_origin_dir_missing")
            result.repairable.append("alias")
        else:
            alias = verify_scene_origin_alias(scene, version.asset_version)
            if alias is False:
                result.problems.append("current_alias_mismatch")
                result.repairable.append("alias")
            version_link = slug_dir / "versions" / version.asset_version
            if not version_link.exists() and not version_link.is_symlink():
                result.problems.append("origin_version_link_missing")
                result.repairable.append("alias")
            for stale in slug_dir.glob(".current.tmp-*"):
                result.notes.append(f"stale_temp_link:{stale.name}")

    return result


def repair_scene(session: Session, scene: Scene, result: SceneConsistency) -> SceneConsistency:
    """Re-point only the mutable aliases at the DB-designated version.

    Refuses (``manual_intervention_required``) when the target version bytes
    are absent — the immutable version itself is never modified or removed.
    """
    if not result.repairable:
        return result
    if {"version_directory_missing", "version_entry_missing"} & set(result.problems):
        result.notes.append("manual_intervention_required")
        return result
    version = (
        session.get(SceneVersion, scene.current_version_id)
        if scene.current_version_id
        else None
    )
    if version is None:
        result.notes.append("manual_intervention_required")
        return result

    if bridge_scene_origin(scene, version.asset_version):
        result.repaired.append("alias")
        if verify_scene_origin_alias(scene, version.asset_version) is False:
            result.notes.append("alias_repair_verification_failed")
        else:
            alias_problems = {
                "current_alias_mismatch",
                "origin_version_link_missing",
                "scene_origin_dir_missing",
            }
            remaining = [
                problem for problem in result.problems if problem in alias_problems
            ]
            result.problems = [p for p in result.problems if p not in remaining]
            result.repairable = []
    else:
        result.notes.append("alias_repair_failed")
    return result


def check_scenes(
    session: Session,
    *,
    slug: str | None = None,
    limit: int | None = None,
    repair: bool = False,
) -> list[SceneConsistency]:
    query = select(Scene).order_by(Scene.created_at.asc(), Scene.id.asc())
    if slug is not None:
        query = query.where(Scene.slug == slug)
    if limit is not None:
        query = query.limit(limit)
    results: list[SceneConsistency] = []
    for scene in session.scalars(query):
        if scene.deleted_at is not None:
            continue
        result = check_scene(session, scene)
        if repair and result.repairable:
            result = repair_scene(session, scene, result)
        results.append(result)
    if repair:
        session.commit()
    return results


def scene_by_slug(session: Session, slug: str) -> Scene | None:
    return session.scalar(select(Scene).where(Scene.slug == slug))


def scene_by_id(session: Session, scene_id: uuid.UUID) -> Scene | None:
    return session.get(Scene, scene_id)

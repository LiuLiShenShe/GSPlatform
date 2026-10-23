"""Seed a GS-NEXT-11 scene with two REAL, loadable versions (A and B).

Purpose: exercise scene version management / rollback end-to-end with the real
official viewer, not mocks.

* Version A (``streamed-sog``): a copy of a real streamed SOG version
  (``lod-meta.json`` + chunk dirs) produced by the pinned splat-transform CLI.
* Version B (``sog``): a copy of a real single-file SOG.

Byte copies only — the donor assets are never modified. Only this slug's rows
are rewritten (idempotent), and only in the isolated test DB.

Usage::

    python scripts/gsnext11_seed_versions_fixture.py            # seed
    python scripts/gsnext11_seed_versions_fixture.py --serve-b   # make B current
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from psycopg2.extras import Json  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

DSN = os.environ.get(
    "GS_SEED_DSN",
    "postgresql+psycopg2://gsplatform_vr00_20261011:"
    "RUZlJu268QniXtylrUVU7pFcWwIrq1Vp-LVxnWYKytlv1w-G"
    "@127.0.0.1:5432/gsplatform_vr00_tests_20261011",
)
OWNER_EMAIL = os.environ.get("GS_SEED_OWNER_EMAIL", "dev@gsplatform.local")
SLUG = os.environ.get("GS_SEED_SLUG", "gsnext11-versions")

STATE = Path(os.path.expanduser("~/.local/state/gsplatform-vr00-20261011"))
STORAGE = Path(os.environ.get("GS_SEED_STORAGE_ROOT", str(STATE / "dev-storage")))
ORIGIN = Path(os.environ.get("GS_SEED_SCENE_ORIGIN", str(STATE / "scene-origin")))

# Donors: real published version directories (outside the repo, never mutated).
STREAMED_DONOR = Path(
    "/home/test/gsplatform-data/published/a328ff72-c4f3-4d1b-bde8-6e0aa88730b1"
    "/versions/b2cc7bb1594d"
)
REGULAR_DONOR = Path(
    str(STATE / "scene-origin" / "fix02-semantics" / "versions" / "f2f055c5bd87")
)

VERSION_A = "d1a111111111"  # streamed-sog
VERSION_B = "d1b222222222"  # regular sog
A_COUNTS = [179, 536, 1788]
B_COUNTS = [59400]

INITIAL_CAMERA = {
    "position": (3.0, 1.8, 6.0),
    "target": (0.0, 0.6, 0.0),
    "fov": 47.0,
}


def _published_dir(scene_id: uuid.UUID, asset_version: str) -> Path:
    return STORAGE / "published" / str(scene_id) / "versions" / asset_version


def _copy_version(
    scene_id: uuid.UUID,
    asset_version: str,
    donor: Path,
    *,
    fmt: str,
    counts: list[int],
) -> tuple[int, dict]:
    target = _published_dir(scene_id, asset_version)
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(donor, target)

    if fmt == "streamed-sog":
        manifest = {
            "schemaVersion": 1,
            "sceneId": str(scene_id),
            "assetVersion": asset_version,
            "format": "streamed-sog",
            "stream": {
                "entryUrl": f"versions/{asset_version}/lod-meta.json",
                "byteLength": (target / "lod-meta.json").stat().st_size,
                "transport": "range",
                "lodLevels": len(counts),
                "counts": counts,
            },
        }
        entry = "lod-meta.json"
    else:
        manifest = json.loads((donor / "manifest.json").read_text())
        manifest["sceneId"] = str(scene_id)
        manifest["assetVersion"] = asset_version
        manifest["assetUrl"] = f"versions/{asset_version}/scene.sog"
        manifest["content"]["entryUrl"] = f"versions/{asset_version}/scene.sog"
        manifest["content"]["counts"] = counts
        entry = "scene.sog"
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return (target / entry).stat().st_size, manifest


def _bridge_origin(scene_slug: str, scene_id: uuid.UUID, asset_versions: list[str]) -> None:
    """Mirror the publish bridge: ``versions/<av>`` links + ``current -> versions/<av>``."""
    slug_dir = ORIGIN / scene_slug
    slug_dir.mkdir(parents=True, exist_ok=True)
    versions = slug_dir / "versions"
    versions.mkdir(exist_ok=True)
    for asset_version in asset_versions:
        link = versions / asset_version
        target = _published_dir(scene_id, asset_version)
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(target, target_is_directory=True)
    current = slug_dir / "current"
    if current.is_symlink():
        current.unlink()
    current.symlink_to(f"versions/{asset_versions[0]}", target_is_directory=True)


def seed() -> None:
    engine = create_engine(DSN)
    with engine.begin() as conn:
        owner = conn.execute(
            text("select id from users where email = :e"), {"e": OWNER_EMAIL}
        ).scalar()
        if owner is None:
            raise SystemExit(f"owner {OWNER_EMAIL} missing in {DSN}")

        existing = conn.execute(
            text("select id from scenes where slug = :s"), {"s": SLUG}
        ).scalar()
        if existing is not None:
            conn.execute(
                text("update scenes set current_version_id = NULL where id = :s"),
                {"s": existing},
            )
            for table in (
                "scene_annotations",
                "scene_viewpoints",
                "scene_presentations",
                "scene_spatial_states",
                # assets FK -> scene_versions: drop the children first.
                "assets",
                "scene_versions",
                "collision_assets",
                "favorites",
                "jobs",
                "scene_edit_sessions",
                "scene_processing_settings",
                "share_links",
                "upload_sessions",
            ):
                conn.execute(
                    text(f"delete from {table} where scene_id = :s"), {"s": existing}
                )
            conn.execute(text("delete from scenes where id = :s"), {"s": existing})

        scene_id = uuid.uuid4()
        size_a, manifest_a = _copy_version(
            scene_id, VERSION_A, STREAMED_DONOR, fmt="streamed-sog", counts=A_COUNTS
        )
        size_b, manifest_b = _copy_version(
            scene_id, VERSION_B, REGULAR_DONOR, fmt="sog", counts=B_COUNTS
        )

        conn.execute(
            text(
                "insert into scenes (id, owner_id, slug, title, description, category,"
                " visibility, status, current_version_id, splat_count, size_bytes, views,"
                " likes, created_at, updated_at, published_at)"
                " values (:id, :owner, :slug, :title, :desc, 'experiment', 'PUBLIC',"
                " 'PUBLISHED', NULL, :splat, :size, 0, 0, now(), now(), now())"
            ),
            {
                "id": scene_id,
                "owner": owner,
                "slug": SLUG,
                "title": f"{SLUG} 版本切换夹具",
                "desc": "A=streamed-sog / B=sog，版本管理与回滚 e2e",
                "splat": A_COUNTS[-1],
                "size": size_a,
            },
        )

        rows = [
            (uuid.uuid4(), VERSION_A, "streamed-sog", size_a, manifest_a, "A"),
            (uuid.uuid4(), VERSION_B, "sog", size_b, manifest_b, "B"),
        ]
        version_ids: dict[str, uuid.UUID] = {}
        for version_id, av, fmt, size, manifest, label in rows:
            version_ids[label] = version_id
            conn.execute(
                text(
                    "insert into scene_versions (id, scene_id, asset_version, format,"
                    " size_bytes, sha256, manifest, created_at)"
                    " values (:id, :scene, :av, :fmt, :size, NULL, :manifest, now())"
                ),
                {
                    "id": version_id,
                    "scene": scene_id,
                    "av": av,
                    "fmt": fmt,
                    "size": size,
                    "manifest": Json(manifest),
                },
            )
            entry = "lod-meta.json" if fmt == "streamed-sog" else "scene.sog"
            conn.execute(
                text(
                    "insert into assets (id, scene_id, version_id, kind, storage_key,"
                    " mime_type, byte_size, sha256, metadata_, created_at)"
                    " values (:id, :scene, :ver, 'SOG', :key, :mime, :size, '', :meta, now())"
                ),
                {
                    "id": uuid.uuid4(),
                    "scene": scene_id,
                    "ver": version_id,
                    "key": f"published/{scene_id}/versions/{av}/{entry}",
                    "mime": "application/json" if fmt == "streamed-sog" else "application/octet-stream",
                    "size": size,
                    "meta": Json({"counts": A_COUNTS if fmt == "streamed-sog" else B_COUNTS}),
                },
            )
            conn.execute(
                text(
                    "insert into assets (id, scene_id, version_id, kind, storage_key,"
                    " mime_type, byte_size, sha256, metadata_, created_at)"
                    " values (:id, :scene, :ver, 'MANIFEST', :key,"
                    " 'application/json', 0, '', :meta, now())"
                ),
                {
                    "id": uuid.uuid4(),
                    "scene": scene_id,
                    "ver": version_id,
                    "key": f"published/{scene_id}/versions/{av}/manifest.json",
                    "meta": Json({"entryUrl": manifest.get("assetUrl")}),
                },
            )

        # A is current initially; the browser test switches to B and back.
        conn.execute(
            text("update scenes set current_version_id = :v where id = :id"),
            {"v": version_ids["A"], "id": scene_id},
        )

        # Authored spatial config so the STALE protection is observable.
        conn.execute(
            text(
                "insert into scene_presentations (id, scene_id, world_position,"
                " world_rotation, world_scale, initial_camera_position,"
                " initial_camera_target, initial_camera_fov, background_type,"
                " background_audio_volume, background_audio_loop,"
                " background_audio_enabled, collision_gravity,"
                " collision_slope_limit_degrees, collision_step_offset,"
                " collision_player_height, collision_enabled, tonemapping,"
                " high_precision_rendering, created_at, updated_at)"
                " values (:id, :scene, NULL, NULL, NULL, :cp, :ct, :cf, 'color', 0.5,"
                " true, false, 9.81, 45, 0.3, 1.8, false, 'aces', false, now(), now())"
            ),
            {
                "id": uuid.uuid4(),
                "scene": scene_id,
                "cp": Json({"x": INITIAL_CAMERA["position"][0],
                            "y": INITIAL_CAMERA["position"][1],
                            "z": INITIAL_CAMERA["position"][2]}),
                "ct": Json({"x": INITIAL_CAMERA["target"][0],
                            "y": INITIAL_CAMERA["target"][1],
                            "z": INITIAL_CAMERA["target"][2]}),
                "cf": INITIAL_CAMERA["fov"],
            },
        )
        conn.execute(
            text(
                "insert into scene_viewpoints (id, scene_id, name, position, target,"
                " fov, order_index, enabled, created_at, updated_at)"
                " values (:id, :scene, '版本 A 视角', :pos, :tgt, 52, 0, true, now(), now())"
            ),
            {
                "id": uuid.uuid4(),
                "scene": scene_id,
                "pos": Json({"x": 3.0, "y": 2.0, "z": 7.0}),
                "tgt": Json({"x": 0.0, "y": 0.5, "z": 0.0}),
            },
        )
        conn.execute(
            text(
                "insert into scene_spatial_states (scene_id, source_version_id, state,"
                " stale_at) values (:scene, :ver, 'VALID', now())"
            ),
            {"scene": scene_id, "ver": version_ids["A"]},
        )

    _bridge_origin(SLUG, scene_id, [VERSION_A, VERSION_B])
    print(
        f"seeded {SLUG} scene_id={scene_id} A={version_ids['A']} ({VERSION_A},"
        f" streamed) B={version_ids['B']} ({VERSION_B}, sog); A is current"
    )


if __name__ == "__main__":
    seed()
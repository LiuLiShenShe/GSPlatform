"""Seed a dedicated `gsnext10-recovery` scene for the delete→restore→Viewer e2e.

Why a separate scene: the shared `fix02-semantics` fixture is consumed by the
camera/viewpoint specs, and deleting it would break them. This fixture is its
own row/versions + its own scene-origin root (bytes copied from the same
published SOG), so the real official viewer can load it before deletion and
again after restoration.

Idempotent: wipes and re-creates only this slug. Isolated staging DB only.
"""

from __future__ import annotations

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
    "@127.0.0.1:5432/gsplatform_vr00_20261011",
)
OWNER_EMAIL = os.environ.get("GS_SEED_OWNER_EMAIL", "dev@gsplatform.local")
SLUG = "gsnext10-recovery"
SOURCE_SLUG = "fix02-semantics"
DONOR_VERSION = "f2f055c5bd87"
SIZE = 292618

STATE = Path(os.path.expanduser("~/.local/state/gsplatform-vr00-20261011"))
ORIGIN = Path(os.environ.get("GS_SEED_SCENE_ORIGIN", str(STATE / "scene-origin")))

INITIAL = {"position": (2.5, 1.8, 6.0), "target": (0.0, 0.6, 0.0), "fov": 47.0}


def main() -> None:
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
                "scene_versions",
                "assets",
                "collision_assets",
                "favorites",
                "jobs",
                "scene_edit_sessions",
                "scene_processing_settings",
                "share_links",
                "upload_sessions",
            ):
                conn.execute(text(f"delete from {table} where scene_id = :s"), {"s": existing})
            conn.execute(text("delete from scenes where id = :s"), {"s": existing})

        scene_id = uuid.uuid4()
        version_id = uuid.uuid4()
        conn.execute(
            text(
                "insert into scenes (id, owner_id, slug, title, description, category,"
                " visibility, status, current_version_id, splat_count, size_bytes, views,"
                " likes, created_at, updated_at, published_at)"
                " values (:id, :owner, :slug, :title, :desc, 'experiment', 'PUBLIC',"
                " 'PUBLISHED', NULL, 59400, :size, 0, 0, now(), now(), now())"
            ),
            {
                "id": scene_id,
                "owner": owner,
                "slug": SLUG,
                "title": "GS-NEXT-10 recovery fixture",
                "desc": "delete -> restore -> Viewer e2e fixture",
                "size": SIZE,
            },
        )
        conn.execute(
            text(
                "insert into scene_versions (id, scene_id, asset_version, format,"
                " size_bytes, sha256, manifest, created_at)"
                " values (:id, :scene, :av, 'sog', :size, NULL, NULL, now())"
            ),
            {"id": version_id, "scene": scene_id, "av": DONOR_VERSION, "size": SIZE},
        )
        conn.execute(
            text("update scenes set current_version_id = :v where id = :id"),
            {"v": version_id, "id": scene_id},
        )
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
                "cp": Json({"x": INITIAL["position"][0], "y": INITIAL["position"][1],
                            "z": INITIAL["position"][2]}),
                "ct": Json({"x": INITIAL["target"][0], "y": INITIAL["target"][1],
                            "z": INITIAL["target"][2]}),
                "cf": INITIAL["fov"],
            },
        )
        conn.execute(
            text(
                "insert into scene_viewpoints (id, scene_id, name, position, target,"
                " fov, order_index, enabled, created_at, updated_at)"
                " values (:id, :scene, '恢复验证视角', :pos, :tgt, 52, 0, true, now(), now())"
            ),
            {
                "id": uuid.uuid4(),
                "scene": scene_id,
                "pos": Json({"x": 3.0, "y": 2.0, "z": 7.0}),
                "tgt": Json({"x": 0.0, "y": 0.5, "z": 0.0}),
            },
        )
        print(f"seeded {SLUG} scene_id={scene_id} version={version_id}")

    # Bytes: the official viewer resolves the current asset under this scene's
    # own origin root; copy the already-published SOG. Never touches historical
    # assets of the source scene.
    src = ORIGIN / SOURCE_SLUG
    dst = ORIGIN / SLUG
    if src.exists():
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        print(f"copied origin {src} -> {dst}")
    else:
        print(f"WARNING: source origin {src} missing; asset will 404")


if __name__ == "__main__":
    main()

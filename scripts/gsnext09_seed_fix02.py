"""Seed the `fix02-semantics` e2e fixture scene into the isolated VR-00 staging DB.

Contract (from apps/web/e2e/fix02-semantics.spec.ts and the GS-NEXT-02/03/04/05
specs, which all use the same scene):
  - authored Initial Camera: position [2.5,1.8,6] / target [0,0.6,0] / fov 47
  - 3 annotations A/B/C, each with a distinct camera
  - 1 saved viewpoint 正门视角 [3,2,7] / [0,0.5,0] / fov 52
  - identity world transform, tonemapping aces
  - PUBLIC + PUBLISHED, current version pointing at a REAL published SOG

The scene bytes reference the already-published GS-NEXT-09 scene version
(f2f055c5bd87) so the official viewer renders real Gaussians without touching
any historical asset. This is an isolated staging DB; no production data is
modified.
"""

from __future__ import annotations

import os
import sys
import uuid
from types import SimpleNamespace
from datetime import UTC, datetime
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
# Owner: an explicit user email, or the dev-identity user the e2e specs act as.
OWNER_EMAIL = os.environ.get("GS_SEED_OWNER_EMAIL", "dev@gsplatform.local")

SLUG = "fix02-semantics"
OWNER_SLUG = "u-58e2857c8218"          # GS-NEXT-09 audit user's scene
DONOR_VERSION = "f2f055c5bd87"          # real published SOG asset version

DB = {
    "initial": {"position": [2.5, 1.8, 6.0], "target": [0.0, 0.6, 0.0], "fov": 47.0},
    "annotations": [
        {"title": "标注A", "position": [1.0, 1.6, 4.5], "target": [-0.5, 0.8, 0.0], "fov": 40.0},
        {"title": "标注B", "position": [-2.0, 1.5, 5.0], "target": [0.2, 0.6, 0.0], "fov": 50.0},
        {"title": "标注C", "position": [0.5, 1.4, 6.5], "target": [0.9, 0.5, 0.0], "fov": 60.0},
    ],
    "viewpoint": {"name": "正门视角", "position": [3.0, 2.0, 7.0], "target": [0.0, 0.5, 0.0], "fov": 52.0},
}


def main() -> None:
    engine = create_engine(DSN)
    with engine.begin() as conn:
        donor_scene = conn.execute(
            text("select id, owner_id from scenes where slug = :s"), {"s": OWNER_SLUG}
        ).first()
        donor = conn.execute(
            text(
                "select asset_version, size_bytes, sha256 from scene_versions"
                " where scene_id = :s and asset_version = :v"
            ),
            {"s": donor_scene.id if donor_scene else None, "v": DONOR_VERSION},
        ).first() if donor_scene else None
        if donor is None:
            # Bytes already live in the shared scene-origin tree; the row only
            # needs the same asset_version/size/sha this audit published.
            donor = SimpleNamespace(asset_version=DONOR_VERSION, size_bytes=292618, sha256=None)
        if OWNER_EMAIL:
            owner = conn.execute(
                text("select id from users where email = :e"), {"e": OWNER_EMAIL}
            ).scalar()
            if owner is None:
                owner = uuid.uuid4()
                conn.execute(
                    text(
                        "insert into users (id, email, display_name, password_hash,"
                        " is_active, created_at, updated_at) values (:id, :e, :n,"
                        " 'x', true, :now, :now)"
                    ),
                    {"id": owner, "e": OWNER_EMAIL, "n": OWNER_EMAIL, "now": datetime.now(UTC)},
                )
        else:
            owner = donor_scene.owner_id

        # idempotent: wipe any previous seed of this fixture
        existing = conn.execute(
            text("select id from scenes where slug = :s"), {"s": SLUG}
        ).scalar()
        if existing is not None:
            # `scenes.current_version_id` FKs into `scene_versions`, so break that
            # pointer before deleting the version rows (otherwise the delete of
            # scene_versions is refused by the still-referencing scenes row).
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
                # 其余指向 scenes 的外键行（作业/资产/分享/收藏…）必须一起清掉，
                # 否则删 scenes 会被外键拒绝，夹具无法重复播种。
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
            print(f"removed previous fixture scene {SLUG}")

        scene_id = uuid.uuid4()
        version_id = uuid.uuid4()
        now = datetime.now(UTC)

        conn.execute(
            text(
                "insert into scenes (id, owner_id, slug, title, description, category,"
                " visibility, status, current_version_id, splat_count, size_bytes, views,"
                " likes, created_at, updated_at, published_at)"
                " values (:id, :owner, :slug, :title, :desc, 'experiment', 'PUBLIC',"
                " 'PUBLISHED', NULL, 59400, :size, 0, 0, :now, :now, :now)"
            ),
            {
                "id": scene_id,
                "owner": owner,
                "slug": SLUG,
                "title": "FIX-02 semantics fixture",
                "desc": "e2e fixture for initial camera / viewpoint / annotation contract",
                "size": int(donor.size_bytes or 0),
                "now": now,
            },
        )

        # SceneVersion rows are per-scene: the SOG bytes live under the fixture's
        # own scene-origin root (copied in by the seed step), so the asset URL
        # resolves against this scene id.
        conn.execute(
            text(
                "insert into scene_versions (id, scene_id, asset_version, format,"
                " size_bytes, sha256, manifest, created_at)"
                " values (:id, :scene, :av, 'sog', :size, :sha, :manifest, :now)"
            ),
            {
                "id": version_id,
                "scene": scene_id,
                "av": donor.asset_version,
                "size": int(donor.size_bytes or 0),
                "sha": donor.sha256,
                "manifest": None,
                "now": now,
            },
        )
        conn.execute(
            text("update scenes set current_version_id = :ver where id = :id"),
            {"ver": version_id, "id": scene_id},
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
                " values (:id, :scene, :wp, :wr, :ws, :cp, :ct, :cf, 'color', 0.5,"
                " true, false, 9.81, 45, 0.3, 1.8, false, 'aces', false, :now, :now)"
            ),
            {
                "id": uuid.uuid4(),
                "scene": scene_id,
                "wp": None,
                "wr": None,
                "ws": None,
                "cp": Json({"x": DB["initial"]["position"][0],
                            "y": DB["initial"]["position"][1],
                            "z": DB["initial"]["position"][2]}),
                "ct": Json({"x": DB["initial"]["target"][0],
                            "y": DB["initial"]["target"][1],
                            "z": DB["initial"]["target"][2]}),
                "cf": DB["initial"]["fov"],
                "now": now,
            },
        )

        for index, note in enumerate(DB["annotations"]):
            conn.execute(
                text(
                    "insert into scene_annotations (id, scene_id, title, description,"
                    " anchor_x, anchor_y, anchor_z, style, content_type,"
                    " text_content, text_color, text_size, fov, order_index,"
                    " enabled, camera_position_x, camera_position_y, camera_position_z,"
                    " camera_target_x, camera_target_y, camera_target_z, camera_fov,"
                    " created_at, updated_at)"
                    " values (:id, :scene, :title, '', :ax, :ay, :az, 'DEFAULT',"
                    " 'TEXT', :title, '#ffffff', 24, 50,"
                    " :ord, true, :cpx, :cpy, :cpz, :ctx, :cty, :ctz, :cf, :now, :now)"
                ),
                {
                    "id": uuid.uuid4(),
                    "scene": scene_id,
                    "title": note["title"],
                    "ax": note["target"][0],
                    "ay": note["target"][1],
                    "az": note["target"][2],
                    "ord": index,
                    "cpx": note["position"][0],
                    "cpy": note["position"][1],
                    "cpz": note["position"][2],
                    "ctx": note["target"][0],
                    "cty": note["target"][1],
                    "ctz": note["target"][2],
                    "cf": note["fov"],
                    "now": now,
                },
            )

        view = DB["viewpoint"]
        conn.execute(
            text(
                "insert into scene_viewpoints (id, scene_id, name, position, target,"
                " fov, order_index, enabled, created_at, updated_at)"
                " values (:id, :scene, :name, :pos, :tgt, :fov, 0, true, :now, :now)"
            ),
            {
                "id": uuid.uuid4(),
                "scene": scene_id,
                "name": view["name"],
                "pos": Json({"x": view["position"][0], "y": view["position"][1],
                             "z": view["position"][2]}),
                "tgt": Json({"x": view["target"][0], "y": view["target"][1],
                             "z": view["target"][2]}),
                "fov": view["fov"],
                "now": now,
            },
        )

        print(f"seeded {SLUG} scene_id={scene_id} version={version_id}")


if __name__ == "__main__":
    main()

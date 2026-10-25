"""Seed the GS-DESKTOP-04 §六 isolated WALK-SAFETY fixtures.

Why a dedicated fixture
-----------------------
The official viewer decides whether walk mode exists with

    isWalkAllowed(bbox, collision)
        = !!collision && halfExtents.x * 2 >= 5 && halfExtents.z * 2 >= 5

It knows nothing about GSPlatform's 1 scene-unit = 1 metre calibration
semantics. To prove the platform gate is a *root* gate (no collision is ever
handed to the official viewer when the platform does not trust it) we need
scenes where the official logic alone would say **yes** while the platform
says **no** — plus one fully trusted control scene where walk must still work.

What this script builds (all rows scoped to the isolated test DB / dev storage)
------------------------------------------------------------------------------
Three scenes, identical REAL content (a copy of the published streamed-SOG
version used by ``gsdesktop01-versions``; horizontal footprint 7.61m × 6.89m,
so the official 5-unit threshold is satisfied) and **real collision artifacts**
produced by the pinned ``splat-transform`` generator for exactly that content:

  ``gsdesktop04-walk-safe``
      calibration VERIFIED, 1 m/unit, identity transform, collision built on
      the current world transform → runtime descriptor
      ``collision.enabled=true, stale=false`` → the platform injects it →
      official ``walkAllowed === true`` → Walk (UI / keyboard 3 / host API) works.

  ``gsdesktop04-walk-stale``
      same collision + calibration, but the build recorded a *different* world
      transform hash → ``enabled=true, stale=true`` (the exact reachable hole:
      the collision URL is still served). The official viewer would happily
      walk; the platform must refuse.

  ``gsdesktop04-walk-uncalibrated``
      collision built correctly, but the physical scale was never verified
      (``calibration_state='UNVERIFIED'``) → backend folds it into
      ``collision.enabled=false``; the platform must refuse as well.

Every variant therefore keeps a real, loadable collision asset on disk — the
gate is about *whether the platform hands it to the viewer*, never about the
asset being fake.

Usage::

    python scripts/gsdesktop04_seed_walk_fixture.py           # seed / re-seed
    python scripts/gsdesktop04_seed_walk_fixture.py --verify  # print descriptors

Only this script's three slugs are rewritten (idempotent). Donor bytes are
copied, never modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import uuid
from dataclasses import dataclass
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

STATE = Path(os.path.expanduser("~/.local/state/gsplatform-vr00-20261011"))
# The dev API (:8001) serves assets from dev-storage and reads collision bytes
# from the same storage root — both live here.
STORAGE = Path(os.environ.get("GS_SEED_STORAGE_ROOT", str(STATE / "dev-storage")))
ORIGIN = Path(os.environ.get("GS_SEED_SCENE_ORIGIN", str(STATE / "scene-origin")))

# REAL donor content: the streamed-SOG version published for gsdesktop01-versions.
# Bounds: min [-3.397647, -1.796057, 7.476062] / max [4.216939, 1.253376, 14.36274]
# → 7.61 × 6.89 horizontal (both ≥ the official 5-unit walk threshold).
CONTENT_DONOR = (
    STORAGE / "published" / "29eafd2d-8745-47bc-b90b-6cb2340789b7" / "versions" / "d1a111111111"
)

ASSET_VERSION = "w4a100000001"
SPLAT_COUNT = 2503

INITIAL_CAMERA = {"position": (0.4, 1.6, 6.5), "target": (0.4, -0.2, 11.0), "fov": 55.0}

VARIANTS = (
    # slug suffix, calibration_state, force stale collision
    ("safe", "VERIFIED", False),
    ("stale", "VERIFIED", True),
    ("uncalibrated", "UNVERIFIED", False),
)

WALK_GLB_NAME = "collision.glb"
WALK_VOXEL_JSON = "collision.voxel.json"
WALK_VOXEL_BIN = "collision.voxel.bin"


@dataclass
class Seeded:
    slug: str
    scene_id: uuid.UUID
    version_id: uuid.UUID
    collision_dir: Path


def _published_dir(scene_id: uuid.UUID) -> Path:
    return STORAGE / "published" / str(scene_id) / "versions" / ASSET_VERSION


def _copy_content(scene_id: uuid.UUID) -> tuple[int, dict]:
    if not (CONTENT_DONOR / "lod-meta.json").is_file():
        raise SystemExit(f"content donor missing: {CONTENT_DONOR}")
    target = _published_dir(scene_id)
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(CONTENT_DONOR, target)
    meta = json.loads((target / "lod-meta.json").read_text())
    manifest = {
        "schemaVersion": 1,
        "sceneId": str(scene_id),
        "assetVersion": ASSET_VERSION,
        "format": "streamed-sog",
        "stream": {
            "entryUrl": f"versions/{ASSET_VERSION}/lod-meta.json",
            "byteLength": (target / "lod-meta.json").stat().st_size,
            "transport": "range",
            "lodLevels": len(meta.get("counts") or []),
            "counts": meta.get("counts") or [],
        },
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return (target / "lod-meta.json").stat().st_size, manifest


def _bridge_origin(slug: str, scene_id: uuid.UUID) -> None:
    slug_dir = ORIGIN / slug
    versions = slug_dir / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    link = versions / ASSET_VERSION
    target = _published_dir(scene_id)
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(target, target_is_directory=True)
    current = slug_dir / "current"
    if current.is_symlink():
        current.unlink()
    current.symlink_to(f"versions/{ASSET_VERSION}", target_is_directory=True)


def _build_real_collision(source: Path, out_dir: Path) -> dict:
    """Run the PINNED splat-transform generator on the real scene content."""
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo))
    from workers.collision.splat import build_collision_artifacts  # noqa: PLC0415

    # GPU 0 is the free adapter on this host (GPU 1 belongs to a shared job).
    result = build_collision_artifacts(source, out_dir, mode="OUTDOOR", gpu="0")
    if not result.ok:
        raise SystemExit(
            "collision generation failed: " + ("; ".join(result.warnings) or "unknown")
        )
    return {
        "paths": {
            "glb": result.collision_glb,
            "voxelJson": result.voxel_json,
            "voxelBin": result.voxel_bin,
        },
        "params": result.to_params(),
        "warnings": result.warnings,
    }


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _drop_existing(conn, slug: str) -> None:
    existing = conn.execute(
        text("select id from scenes where slug = :s"), {"s": slug}
    ).scalar()
    if existing is None:
        return
    conn.execute(
        text("update scenes set current_version_id = NULL where id = :s"), {"s": existing}
    )
    for table in (
        "scene_annotations",
        "scene_viewpoints",
        "scene_presentations",
        "scene_spatial_states",
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
        conn.execute(text(f"delete from {table} where scene_id = :s"), {"s": existing})
    conn.execute(text("delete from scenes where id = :s"), {"s": existing})


def seed(build_collision: bool = True) -> list[Seeded]:
    engine = create_engine(DSN)
    seeded: list[Seeded] = []
    with engine.begin() as conn:
        owner = conn.execute(
            text("select id from users where email = :e"), {"e": OWNER_EMAIL}
        ).scalar()
        if owner is None:
            raise SystemExit(f"owner {OWNER_EMAIL} missing in {DSN}")

        # 1) REAL collision artifacts, generated once from the REAL content.
        collision_src = STATE / "gsdesktop04-walk-collision"
        if build_collision or not (collision_src / WALK_VOXEL_JSON).is_file():
            if collision_src.exists():
                shutil.rmtree(collision_src)
            collision_src.mkdir(parents=True, exist_ok=True)
            built = _build_real_collision(CONTENT_DONOR / "lod-meta.json", collision_src)
            build_params_template = built["params"]
            print(f"collision generated: {built['paths']} warnings={built['warnings']}")
        else:
            build_params_template = {
                "tool": "splat-transform",
                "toolVersion": "3.3.3",
                "mode": "OUTDOOR",
                "gpu": "0",
            }

        voxel_meta = json.loads((collision_src / WALK_VOXEL_JSON).read_text())
        print(
            "collision voxel meta:",
            json.dumps(
                {
                    k: voxel_meta.get(k)
                    for k in (
                        "version",
                        "gridBounds",
                        "sceneBounds",
                        "voxelResolution",
                        "nodeCount",
                        "leafDataCount",
                    )
                }
            ),
        )

        for suffix, calibration, force_stale in VARIANTS:
            slug = f"gsdesktop04-walk-{suffix}"
            _drop_existing(conn, slug)

            scene_id = uuid.uuid4()
            version_id = uuid.uuid4()
            size, manifest = _copy_content(scene_id)
            _bridge_origin(slug, scene_id)

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
                    "slug": slug,
                    "title": f"{slug} —— GS-DESKTOP-04 walk 安全闸门夹具",
                    "desc": f"真实碰撞资产 + calibration={calibration} + stale={force_stale}",
                    "splat": SPLAT_COUNT,
                    "size": size,
                },
            )
            conn.execute(
                text(
                    "insert into scene_versions (id, scene_id, asset_version, format,"
                    " size_bytes, sha256, manifest, created_at)"
                    " values (:id, :scene, :av, 'streamed-sog', :size, NULL, :manifest, now())"
                ),
                {
                    "id": version_id,
                    "scene": scene_id,
                    "av": ASSET_VERSION,
                    "size": size,
                    "manifest": Json(manifest),
                },
            )
            conn.execute(
                text("update scenes set current_version_id = :v where id = :id"),
                {"v": version_id, "id": scene_id},
            )

            # SOG + manifest asset rows (content serving / metadata).
            conn.execute(
                text(
                    "insert into assets (id, scene_id, version_id, kind, storage_key,"
                    " mime_type, byte_size, sha256, metadata_, created_at)"
                    " values (:id, :scene, :ver, 'SOG', :key, 'application/json', :size, '',"
                    " :meta, now())"
                ),
                {
                    "id": uuid.uuid4(),
                    "scene": scene_id,
                    "ver": version_id,
                    "key": f"published/{scene_id}/versions/{ASSET_VERSION}/lod-meta.json",
                    "size": size,
                    "meta": Json({"counts": manifest["stream"]["counts"]}),
                },
            )
            conn.execute(
                text(
                    "insert into assets (id, scene_id, version_id, kind, storage_key,"
                    " mime_type, byte_size, sha256, metadata_, created_at)"
                    " values (:id, :scene, :ver, 'MANIFEST', :key, 'application/json', 0, '',"
                    " :meta, now())"
                ),
                {
                    "id": uuid.uuid4(),
                    "scene": scene_id,
                    "ver": version_id,
                    "key": f"published/{scene_id}/versions/{ASSET_VERSION}/manifest.json",
                    "meta": Json({"entryUrl": f"versions/{ASSET_VERSION}/lod-meta.json"}),
                },
            )

            # Collision artifacts live in the collision storage area, one job
            # directory per scene (the only layout the service trusts for a
            # job-scoped build; job_id stays NULL → legacy single-build path
            # proves ownership through collision.asset_id).
            job_id = uuid.uuid4()
            rel_dir = (
                f"collision/{scene_id}/versions/{ASSET_VERSION}/jobs/{job_id}/attempts/1"
            )
            coll_dir = STORAGE / rel_dir
            coll_dir.mkdir(parents=True, exist_ok=True)
            for name in (WALK_GLB_NAME, WALK_VOXEL_JSON, WALK_VOXEL_BIN):
                shutil.copy2(collision_src / name, coll_dir / name)

            world_hash = "f" * 16 if force_stale else None
            build_params = {
                **build_params_template,
                "mode": "OUTDOOR",
                "sourceVersion": ASSET_VERSION,
                "sourceVersionId": str(version_id),
                "worldTransformHash": world_hash,
                "physicalScaleVerified": True,
                "collisionJobId": str(job_id),
            }

            voxel_asset_id = uuid.uuid4()
            glb_asset_id = uuid.uuid4()
            conn.execute(
                text(
                    "insert into assets (id, scene_id, version_id, kind, storage_key,"
                    " mime_type, byte_size, sha256, metadata_, created_at)"
                    " values (:id, :scene, :ver, 'COLLISION_VOXEL', :key, 'application/json',"
                    " :size, :sha, :meta, now())"
                ),
                {
                    "id": voxel_asset_id,
                    "scene": scene_id,
                    "ver": version_id,
                    "key": f"{rel_dir}/{WALK_VOXEL_JSON}",
                    "size": (coll_dir / WALK_VOXEL_JSON).stat().st_size,
                    "sha": _sha256(coll_dir / WALK_VOXEL_JSON),
                    "meta": Json(
                        {
                            "mode": "OUTDOOR",
                            "build": build_params_template,
                            "binStorageKey": f"{rel_dir}/{WALK_VOXEL_BIN}",
                            "sourceVersion": ASSET_VERSION,
                            "sourceVersionId": str(version_id),
                            "executionGeneration": 1,
                        }
                    ),
                },
            )
            conn.execute(
                text(
                    "insert into assets (id, scene_id, version_id, kind, storage_key,"
                    " mime_type, byte_size, sha256, metadata_, created_at)"
                    " values (:id, :scene, :ver, 'COLLISION_GLB', :key, 'model/gltf-binary',"
                    " :size, :sha, :meta, now())"
                ),
                {
                    "id": glb_asset_id,
                    "scene": scene_id,
                    "ver": version_id,
                    "key": f"{rel_dir}/{WALK_GLB_NAME}",
                    "size": (coll_dir / WALK_GLB_NAME).stat().st_size,
                    "sha": _sha256(coll_dir / WALK_GLB_NAME),
                    "meta": Json(
                        {
                            "mode": "OUTDOOR",
                            "build": build_params_template,
                            "sourceVersion": ASSET_VERSION,
                            "sourceVersionId": str(version_id),
                            "executionGeneration": 1,
                            # 故意不带 collisionJobId：collision_assets.job_id 为 NULL，
                            # 服务端走 legacy 单次构建解析 —— voxel 由
                            # collision.asset_id 直接命中，GLB 作为同目录兄弟资产
                            # 被唯一命中（collision/mesh 也能取到）。
                        }
                    ),
                },
            )
            conn.execute(
                text(
                    "insert into collision_assets (id, scene_id, mode, asset_id, job_id,"
                    " status, gravity, slope_limit_degrees, step_offset, player_height,"
                    " build_params, error_message, attempt, created_at, updated_at)"
                    " values (:id, :scene, 'OUTDOOR', :asset, NULL, 'SUCCEEDED', 9.81, 45,"
                    " 0.3, 1.8, :params, NULL, 1, now(), now())"
                ),
                {
                    "id": uuid.uuid4(),
                    "scene": scene_id,
                    "asset": voxel_asset_id,
                    "params": Json(build_params),
                },
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
                    " true, false, 9.81, 45, 0.3, 1.8, true, 'aces', false, now(), now())"
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

            if calibration == "VERIFIED":
                conn.execute(
                    text(
                        "insert into scene_processing_settings (scene_id, scene_type,"
                        " conversion_profile, collision_policy, calibration_state,"
                        " meters_per_scene_unit, reference_method, reference_value,"
                        " calibration_source_version, calibration_transform_identity,"
                        " calibration_evidence, created_at, updated_at)"
                        " values (:scene, 'UNSPECIFIED', 'balanced', 'MANUAL_ONLY',"
                        " 'VERIFIED', 1.0, 'MEASURED_DISTANCE', 4.2, :av, 'identity',"
                        " :evidence, now(), now())"
                    ),
                    {
                        "scene": scene_id,
                        "av": ASSET_VERSION,
                        "evidence": Json(
                            {
                                "provenance": "gsdesktop04-walk fixture (measured 4.2m door)",
                                "verifiedBy": "gsdesktop04-seed",
                                "evidenceSha256": "b" * 64,
                            }
                        ),
                    },
                )
            else:
                conn.execute(
                    text(
                        "insert into scene_processing_settings (scene_id, scene_type,"
                        " conversion_profile, collision_policy, calibration_state,"
                        " created_at, updated_at)"
                        " values (:scene, 'UNSPECIFIED', 'balanced', 'MANUAL_ONLY',"
                        " 'UNVERIFIED', now(), now())"
                    ),
                    {"scene": scene_id},
                )

            seeded.append(
                Seeded(
                    slug=slug,
                    scene_id=scene_id,
                    version_id=version_id,
                    collision_dir=coll_dir,
                )
            )

    return seeded


def verify() -> None:
    """Print the runtime descriptor facts the browser tests assert on."""
    engine = create_engine(DSN)
    with engine.connect() as conn:
        for suffix, _, _ in VARIANTS:
            slug = f"gsdesktop04-walk-{suffix}"
            row = conn.execute(
                text(
                    "select s.id, s.current_version_id, c.status, c.asset_id, c.build_params,"
                    " p.collision_enabled, sps.calibration_state"
                    " from scenes s"
                    " left join collision_assets c on c.scene_id = s.id"
                    " left join scene_presentations p on p.scene_id = s.id"
                    " left join scene_processing_settings sps on sps.scene_id = s.id"
                    " where s.slug = :slug"
                ),
                {"slug": slug},
            ).mappings().first()
            print(slug, "->", dict(row) if row else "MISSING")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    parser.add_argument(
        "--reuse-collision",
        action="store_true",
        help="reuse previously generated collision artifacts instead of re-running the generator",
    )
    args = parser.parse_args()
    if args.verify:
        verify()
        return
    for item in seed(build_collision=not args.reuse_collision):
        print(f"seeded {item.slug} scene_id={item.scene_id} collision_dir={item.collision_dir}")


if __name__ == "__main__":
    main()

"""FIX-UPLOAD-01 §C — collision worker binds to the scene's CURRENT version.

The worker's ``_find_sog_asset`` must select the SOG asset whose ``version_id``
equals ``Scene.current_version_id`` (the persistent publish association) — NOT
the most-recently-created SOG row.  And on SUCCEEDED it must record the
``sourceVersion`` binding so an old-version collision can never masquerade as
the current one.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from app.core.config import settings
from app.core.identity import _resolve_dev_user_id
from app.db.models.scene import Scene, SceneVersion
from app.db.session import SessionLocal


def _new_scene(session, *, with_version=True) -> Scene:
    owner = _resolve_dev_user_id(settings)
    scene = Scene(
        owner_id=owner,
        slug=f"fixc-{uuid.uuid4().hex[:10]}",
        title="测试场景",
        category="experiment",
        visibility="PRIVATE",
        status="PUBLISHED",
    )
    session.add(scene)
    session.flush()
    if with_version:
        version = SceneVersion(
            scene_id=scene.id,
            asset_version="v-content-key",
            format="streamed-sog",
            size_bytes=100,
            manifest={"stream": {"counts": [1, 1, 1]}},
        )
        session.add(version)
        session.flush()
        scene.current_version_id = version.id
    session.commit()
    session.refresh(scene)
    return scene


def _add_sog_asset(session, scene, version, *, storage_key, created_delta=0):
    from app.db.models.asset import Asset
    from app.db.models.enums import AssetKind

    asset = Asset(
        scene_id=scene.id,
        version_id=version.id,
        kind=AssetKind.SOG.value,
        storage_key=storage_key,
        mime_type="application/json",
        byte_size=10,
    )
    session.add(asset)
    session.flush()
    if created_delta:
        from datetime import UTC, datetime, timedelta

        asset.created_at = datetime.now(UTC) + timedelta(seconds=created_delta)
    return asset


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


class TestFindSogAssetCurrentVersion:
    def test_selects_current_version_sog_not_newest_created(self, db):
        """_find_sog_asset picks the CURRENT version's SOG even when an OLD
        version's SOG row was created later (pre-fix order_by(created_at.desc())
        would return the old asset)."""
        scene = _new_scene(db)
        current = scene.current_version
        old_version = SceneVersion(
            scene_id=scene.id,
            asset_version="old-content-key",
            format="streamed-sog",
            size_bytes=100,
            manifest={"stream": {"counts": [1, 1, 1]}},
        )
        db.add(old_version)
        db.flush()
        # Old version's SOG created LAST (created_at +5s).
        _add_sog_asset(
            db, scene, old_version,
            storage_key=f"published/{scene.id}/versions/old-content-key/lod-meta.json",
            created_delta=5,
        )
        _add_sog_asset(
            db, scene, current,
            storage_key=f"published/{scene.id}/versions/v-content-key/lod-meta.json",
        )
        db.commit()

        from workers.tasks.build_collision import _find_sog_asset

        picked = _find_sog_asset(db, scene.id)
        assert picked is not None
        assert picked.version_id == current.id
        assert picked.storage_key.endswith("v-content-key/lod-meta.json")

    def test_no_current_version_returns_none(self, db):
        scene = _new_scene(db, with_version=False)
        from workers.tasks.build_collision import _find_sog_asset

        assert _find_sog_asset(db, scene.id) is None

    def test_no_sog_asset_for_current_version_returns_none(self, db):
        scene = _new_scene(db)
        # A version exists but no SOG Asset row is bound to it.
        from workers.tasks.build_collision import _find_sog_asset

        assert _find_sog_asset(db, scene.id) is None


class TestCollisionWorkerVersionBinding:
    def test_success_records_source_version(self, db, monkeypatch):
        """The worker records build_params.sourceVersion = the SOG asset's
        SceneVersion.asset_version on SUCCEEDED."""
        scene = _new_scene(db)
        current = scene.current_version
        sog_key = f"published/{scene.id}/versions/v-content-key/lod-meta.json"
        _add_sog_asset(db, scene, current, storage_key=sog_key)
        # The worker verifies the REAL file exists on disk (§C) — create it.
        sog_path = Path(settings.storage_root) / sog_key
        sog_path.parent.mkdir(parents=True, exist_ok=True)
        sog_path.write_text(
            json.dumps({"version": 1, "counts": [1, 1, 1], "tree": {}, "filenames": []}),
            encoding="utf-8",
        )
        (sog_path.parent / "manifest.json").write_text(
            json.dumps({"schemaVersion": 1}), encoding="utf-8"
        )
        from app.db.models.collision_asset import CollisionAsset
        from app.db.models.enums import JobKind, JobStatus
        from app.db.models.job import Job

        coll = CollisionAsset(scene_id=scene.id, mode="OUTDOOR", status="RUNNING")
        db.add(coll)
        db.flush()
        job = Job(
            scene_id=scene.id,
            owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value,
            status=JobStatus.RUNNING.value,
        )
        db.add(job)
        db.commit()
        # §C pre-finalize ownership: the collision row must already point at
        # THIS job, otherwise the worker correctly supersedes its own build.
        coll.job_id = job.id
        db.commit()

        # §C per-job output isolation: the worker writes into its own per-attempt
        # dir (…/jobs/<jobId>/attempts/<generation>/); the fake writes into the
        # directory the worker passes, mirroring the real generator.
        import workers.collision.splat as splat_mod
        from workers.collision.splat import SplatBuildResult

        def _fake(sog_path, out_dir, **_k):
            out_dir = Path(out_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "collision.voxel.json").write_text(
                json.dumps({"nodeCount": 1}), encoding="utf-8"
            )
            (out_dir / "collision.voxel.bin").write_bytes(b"\x00" * 4)
            (out_dir / "collision.glb").write_bytes(b"\x00" * 4)
            return SplatBuildResult(
                ok=True,
                out_dir=out_dir,
                voxel_json=out_dir / "collision.voxel.json",
                voxel_bin=out_dir / "collision.voxel.bin",
                collision_glb=out_dir / "collision.glb",
                voxel_meta={"nodeCount": 1},
                mode="OUTDOOR",
                gpu="cpu",
                warnings=[],
            )

        # build_collision_artifacts is imported inside the task body from
        # workers.collision.splat — patch the source module, not the task.
        monkeypatch.setattr(splat_mod, "build_collision_artifacts", _fake)
        try:
            from workers.tasks.build_collision import build_collision

            result = build_collision(
                str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
                str(current.id),
            )
            assert result["ok"] is True
        finally:
            monkeypatch.undo()

        db.expire_all()
        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        assert coll.status == "SUCCEEDED"
        assert coll.build_params["sourceVersion"] == current.asset_version
        assert coll.build_params["artifacts"]["voxelJson"] == "collision.voxel.json"
        # The scene's current version id is the SOG's version id — binding equal.
        assert coll.build_params["sourceVersion"] == "v-content-key"
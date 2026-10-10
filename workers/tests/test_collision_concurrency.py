"""FIX-UPLOAD-01.1 §C/§D/§E — collision worker version isolation + concurrency.

RED-first tests locking the PART C/D worker contract on the real PostgreSQL
test database:

* every build carries a pinned ``source_version`` (SceneVersion UUID) as its
  6th task argument;
* pre-finalization ownership re-check — a worker building an old version, or a
  job whose collision row was taken over by a newer job, must FAIL its own job
  with the stable code ``COLLISION_SUPERSEDED`` and never touch the newer
  collision;
* per-job output isolation: ``collision/<sid>/versions/<asset>/jobs/<jobId>/``
  and per-job Asset rows pinned to the source version;
* duplicate delivery of a completed job is a no-op (no regeneration);
* real interleaves (A building / B published / A finishing after B) prove a
  stale worker cannot overwrite or fail the new collision;
* one test drives the REAL pinned splat-transform CLI to build real artifacts.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from app.core.config import settings
from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.session import SessionLocal

STORAGE = Path(settings.storage_root)


# ── helpers ──────────────────────────────────────────────────────────────────
def _new_published_scene(session, *, asset_version="v-content-key") -> Scene:
    from app.core.identity import _resolve_dev_user_id

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
    version = SceneVersion(
        scene_id=scene.id,
        asset_version=asset_version,
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


def _add_sog(session, scene, version, *, asset_version=None) -> None:
    from app.db.models.asset import Asset
    from app.db.models.enums import AssetKind

    key = (
        f"published/{scene.id}/versions/{asset_version or version.asset_version}"
        "/lod-meta.json"
    )
    asset = Asset(
        scene_id=scene.id, version_id=version.id, kind=AssetKind.SOG.value,
        storage_key=key, mime_type="application/json", byte_size=10,
    )
    session.add(asset)
    session.flush()
    path = STORAGE / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "counts": [1, 1, 1], "tree": {}, "filenames": []}), encoding="utf-8")
    (path.parent / "manifest.json").write_text(json.dumps({"schemaVersion": 1}), encoding="utf-8")


def _new_job_and_collision(session, scene, *, status="RUNNING", job_id=None, coll_id=None):
    from app.db.models.collision_asset import CollisionAsset

    coll = CollisionAsset(
        id=coll_id or uuid.uuid4(), scene_id=scene.id, mode="OUTDOOR", status=status,
        gravity=9.81, slope_limit_degrees=45.0, step_offset=0.3, player_height=1.8,
    )
    job = Job(
        id=job_id or uuid.uuid4(), scene_id=scene.id, owner_id=scene.owner_id,
        kind=JobKind.BUILD_COLLISION.value, status=JobStatus.RUNNING.value,
    )
    session.add_all([job, coll])
    session.flush()
    coll.job_id = job.id
    session.commit()
    return job, coll


def _fake_splat(monkeypatch, out_dir: Path | None = None):
    """Patch the generator with a fake that writes artifacts into the worker's
    own ``out_dir`` (per-attempt directory under FIX-UPLOAD-01.3).  When
    ``out_dir`` is given it is used as the write target for compatibility with
    tests that predrive the directory; otherwise the worker-provided one.
    Returns the (single-element) list of directories actually written."""
    import workers.collision.splat as splat_mod
    from workers.collision.splat import SplatBuildResult

    written: list[Path] = []

    def _write(target: Path) -> Path:
        target.mkdir(parents=True, exist_ok=True)
        (target / "collision.voxel.json").write_text(
            json.dumps({"nodeCount": 1, "gridBounds": {"min": [-1, -1, -1], "max": [1, 1, 1]}}),
            encoding="utf-8",
        )
        (target / "collision.voxel.bin").write_bytes(b"\x00" * 4)
        (target / "collision.glb").write_bytes(b"\x00" * 4)
        return target

    if out_dir is not None:
        _write(out_dir)

    def _fake(_sog_path, worker_out_dir, **_k):
        target = out_dir if out_dir is not None else _write(Path(worker_out_dir))
        written.append(target)
        return SplatBuildResult(
            ok=True, out_dir=target,
            voxel_json=target / "collision.voxel.json",
            voxel_bin=target / "collision.voxel.bin",
            collision_glb=target / "collision.glb",
            voxel_meta={"nodeCount": 1, "mode": "OUTDOOR"},
            mode="OUTDOOR", gpu="cpu", warnings=[],
        )

    monkeypatch.setattr(splat_mod, "build_collision_artifacts", _fake)
    return written


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _publish_new_version(session, scene, asset_version) -> SceneVersion:
    ver = SceneVersion(
        scene_id=scene.id, asset_version=asset_version, format="streamed-sog",
        size_bytes=200, manifest={"stream": {"counts": [1, 2, 3]}},
    )
    session.add(ver)
    session.flush()
    scene.current_version_id = ver.id
    session.commit()
    session.refresh(scene)
    return ver


# ─────────────────────────────────────────────────────────────────────────────
# §D — version contract + duplicate delivery + per-job isolation
# ─────────────────────────────────────────────────────────────────────────────
class TestVersionContract:
    def test_success_pins_source_version_and_job_dir(self, db, monkeypatch):
        """A successful build records sourceVersion/sourceVersionId on the
        collision, pins Asset.version_id to the SceneVersion and writes into
        ``collision/<sid>/versions/<asset>/jobs/<jobId>/``."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene)
        _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is True
        assert result["format"] in ("COLLISION_VOXEL", "COLLISION_GLB")

        db.expire_all()
        from app.db.models.asset import Asset as AssetRow
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.status == "SUCCEEDED"
        assert coll.build_params["sourceVersion"] == "v-content-key"
        assert coll.build_params["sourceVersionId"] == str(scene.current_version_id)
        # Per-job storage keys under versions/<asset>/jobs/<jobId>/.
        voxel = (
            db.query(AssetRow)
            .filter(
                AssetRow.scene_id == scene.id,
                AssetRow.kind == "COLLISION_VOXEL",
            )
            .one()
        )
        assert f"/versions/v-content-key/jobs/{job.id}/" in voxel.storage_key
        assert voxel.metadata_["collisionJobId"] == str(job.id)
        assert str(voxel.version_id) == str(scene.current_version_id)
        assert voxel.metadata_["binStorageKey"].startswith(
            f"collision/{scene.id}/versions/v-content-key/jobs/{job.id}/"
        )

    def test_duplicate_delivery_of_completed_job_is_noop(self, db, monkeypatch):
        """Redelivering a task whose job already reached a terminal state is a
        no-op: no regeneration, no new asset rows, no status flip."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene)
        job.status = JobStatus.SUCCEEDED.value
        coll.status = "SUCCEEDED"
        db.commit()

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result.get("ok") is True
        assert result.get("duplicate") is True
        db.expire_all()
        from app.db.models.asset import Asset as AssetRow

        assert (
            db.query(AssetRow)
            .filter(
                AssetRow.scene_id == scene.id,
                AssetRow.kind.in_(["COLLISION_VOXEL", "COLLISION_GLB"]),
            )
            .count()
            == 0
        )

    def test_old_5arg_task_falls_back_to_current_version(self, db, monkeypatch):
        """A task queued before the 6th arg shipped (source_version=None) still
        builds — against the scene's CURRENT version."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene)
        _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        result = build_collision(str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None)
        assert result["ok"] is True
        db.expire_all()
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.build_params["sourceVersion"] == "v-content-key"


# ─────────────────────────────────────────────────────────────────────────────
# §C — stale worker protection (version move / job takeover)
# ─────────────────────────────────────────────────────────────────────────────
class TestStaleWorkerProtection:
    def test_job_a_succeeds_after_b_published_no_overwrite(self, db, monkeypatch):
        """A was building version A; version B got published and B's job took
        over the collision row.  When A finally finishes, A must FAIL with
        COLLISION_SUPERSEDED and leave B's collision row untouched."""
        scene = _new_published_scene(db)
        version_a = scene.current_version
        _add_sog(db, scene, version_a, asset_version="a-content-key")
        job_a, coll = _new_job_and_collision(db, scene)
        coll.build_params = {"sourceVersion": "a-content-key", "sourceVersionId": str(version_a.id)}
        db.commit()

        # B published; B's ensure created a NEW job and took over the row.
        version_b = _publish_new_version(db, scene, "b-content-key")
        _add_sog(db, scene, version_b, asset_version="b-content-key")
        job_b = Job(
            scene_id=scene.id, owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value, status=JobStatus.QUEUED.value,
        )
        db.add(job_b)
        db.flush()
        coll.job_id = job_b.id
        coll.status = "QUEUED"
        db.commit()

        # A's worker now finishes — build against A's version.
        _fake_splat(monkeypatch)
        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(version_a.id),
        )
        assert result["ok"] is False
        assert result.get("error") == "COLLISION_SUPERSEDED"

        db.expire_all()
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.job_id == job_b.id  # B still owns the row
        assert coll.status == "QUEUED"  # A did not touch it
        job_a = db.query(Job).filter(Job.id == job_a.id).one()
        assert job_a.status == JobStatus.FAILED.value
        assert job_a.error_code == "COLLISION_SUPERSEDED"

    def test_job_a_fails_after_b_does_not_fail_b_collision(self, db, monkeypatch):
        """A's build CRASHES mid-run after B took over: A fails only its own
        job (COLLISION_BUILD_FAILED), the collision row bound to B stays."""
        scene = _new_published_scene(db)
        version_a = scene.current_version
        _add_sog(db, scene, version_a, asset_version="a-content-key")
        job_a, coll = _new_job_and_collision(db, scene)
        coll.build_params = {"sourceVersion": "a-content-key", "sourceVersionId": str(version_a.id)}
        # B's job already exists (its publish started) but has NOT taken over —
        # so A passes the pre-build ownership gate and starts building.
        job_b = Job(
            scene_id=scene.id, owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value, status=JobStatus.QUEUED.value,
        )
        db.add(job_b)
        db.commit()
        db.expire_all()

        import workers.collision.splat as splat_mod

        def _boom_after_takeover(*_a, **_k):
            # Mid-build: version B gets published and B's job takes over the
            # collision row, then A's generator crashes.
            from app.db.models.collision_asset import CollisionAsset as _CA
            from app.db.models.scene import Scene as _S
            from app.db.models.scene import SceneVersion as _SV
            from app.db.session import SessionLocal

            s = SessionLocal()
            try:
                ver_b = _SV(
                    scene_id=scene.id, asset_version="b-content-key",
                    format="streamed-sog", size_bytes=200,
                    manifest={"stream": {"counts": [1, 2, 3]}},
                )
                s.add(ver_b)
                s.flush()
                sc = s.get(_S, scene.id)
                sc.current_version_id = ver_b.id
                b_coll = s.get(_CA, coll.id)
                b_coll.job_id = job_b.id
                b_coll.status = "QUEUED"
                s.commit()
            finally:
                s.close()
            raise RuntimeError("gpu exploded")

        monkeypatch.setattr(splat_mod, "build_collision_artifacts", _boom_after_takeover)
        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(version_a.id),
        )
        assert result["ok"] is False
        db.expire_all()
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.status == "QUEUED"  # not FAILED by A
        assert coll.job_id == job_b.id
        job_a = db.query(Job).filter(Job.id == job_a.id).one()
        assert job_a.status == JobStatus.FAILED.value
        assert job_a.error_code == "COLLISION_BUILD_FAILED"

    def test_worker_failure_owns_collision_when_not_taken_over(self, db, monkeypatch):
        """If the failing job STILL owns the collision row, the worker marks the
        collision FAILED (the honest state) and the scene stays PUBLISHED."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene)

        import workers.collision.splat as splat_mod

        def _boom(*_a, **_k):
            raise RuntimeError("gpu exploded")

        monkeypatch.setattr(splat_mod, "build_collision_artifacts", _boom)
        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is False
        db.expire_all()
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.status == "FAILED"
        assert scene.status == "PUBLISHED"

    def test_a_b_output_dirs_and_assets_isolated(self, db, monkeypatch):
        """Two builds for the same scene end up in disjoint per-job dirs with
        per-job Asset rows — the later build neither reuses nor overwrites the
        earlier build's artifacts."""
        scene = _new_published_scene(db, asset_version="a-content-key")
        version_a = scene.current_version
        _add_sog(db, scene, version_a, asset_version="a-content-key")
        job_a, coll = _new_job_and_collision(db, scene)

        from workers.tasks.build_collision import build_collision

        # A builds version A and owns the collision row.
        written_a = _fake_splat(monkeypatch)
        res_a = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None, str(version_a.id)
        )
        assert res_a["ok"] is True
        out_a = written_a[0]

        # Version B published; B's job takes over the collision row.
        version_b = _publish_new_version(db, scene, "b-content-key")
        _add_sog(db, scene, version_b, asset_version="b-content-key")
        job_b = Job(
            scene_id=scene.id, owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value, status=JobStatus.QUEUED.value,
        )
        db.add(job_b)
        db.flush()
        coll.job_id = job_b.id
        coll.status = "QUEUED"
        coll.build_params = {
            "sourceVersion": "b-content-key", "sourceVersionId": str(version_b.id),
        }
        db.commit()
        monkeypatch.undo()

        written_b = _fake_splat(monkeypatch)
        res_b = build_collision(
            str(job_b.id), str(scene.id), str(coll.id), "OUTDOOR", None, str(version_b.id)
        )
        assert res_b["ok"] is True
        out_b = written_b[0]

        db.expire_all()
        from app.db.models.asset import Asset as AssetRow

        keys = {
            a.storage_key
            for a in db.query(AssetRow).filter(
                AssetRow.scene_id == scene.id,
                AssetRow.kind == "COLLISION_VOXEL",
            ).all()
        }
        assert len(keys) == 2  # both builds' voxel rows exist, no overwrite
        assert any("/versions/a-content-key/jobs/" in k for k in keys)
        assert any("/versions/b-content-key/jobs/" in k for k in keys)
        # The final collision row belongs to B's build.
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.status == "SUCCEEDED"
        assert coll.build_params["sourceVersion"] == "b-content-key"
        # A's artifacts are still on disk and untouched.
        assert out_a.joinpath("collision.voxel.json").exists()
        assert out_b.joinpath("collision.voxel.json").exists()


# ─────────────────────────────────────────────────────────────────────────────
# §E — REAL pinned splat-transform CLI collision build (honest, slow)
# ─────────────────────────────────────────────────────────────────────────────
_NODE_BIN = (
    Path(__file__).resolve().parent.parent.parent
    / "node_modules"
    / ".pnpm"
    / "@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0"
    / "node_modules"
    / "@playcanvas"
    / "splat-transform"
    / "bin"
    / "cli.mjs"
)

REQUIRES_CLI = pytest.mark.skipif(
    not _NODE_BIN.exists(),
    reason="splat-transform CLI 不在本 checkout（node_modules 未随 git archive 分发）",
)


def _gaussian_ply_bytes(n: int = 512) -> bytes:
    import struct

    props = [
        ("x", "float"), ("y", "float"), ("z", "float"),
        ("f_dc_0", "float"), ("f_dc_1", "float"), ("f_dc_2", "float"),
        ("opacity", "float"),
        ("scale_0", "float"), ("scale_1", "float"), ("scale_2", "float"),
        ("rot_0", "float"), ("rot_1", "float"), ("rot_2", "float"),
        ("rot_3", "float"),
    ]
    head = ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
    head += [f"property {t} {nm}" for nm, t in props]
    head += ["end_header"]
    header = ("\n".join(head) + "\n").encode("ascii")
    rows = []
    for i in range(n):
        x = (i % 16) / 16.0 * 2 - 1
        y = ((i // 16) % 16) / 16.0 * 2 - 1
        z = ((i // 256) % 2) * 0.1
        rows.append(
            struct.pack(
                "<14f", x, y, z, 0.5, 0.5, 0.5, 0.9, -3.0, -3.0, -3.0,
                1.0, 0.0, 0.0, 0.0,
            )
        )
    return header + b"".join(rows)


@REQUIRES_CLI
def test_real_cli_collision_build_produces_artifacts(tmp_path, monkeypatch):
    """A REAL splat-transform collision build through the full worker task:
    PLY → streamed-SOG staging → SOG asset → build_collision (real CLI)."""
    import workers.pipeline.convert_scene as convert_mod
    from workers.collision.splat import SplatCollisionError

    # 1) Convert a real PLY to a real streamed-SOG staging (real CLI).
    src = tmp_path / "upload.bin"
    src.write_bytes(_gaussian_ply_bytes())
    staging = tmp_path / "published" / ".staging"
    cr = convert_mod.convert_to_streamed_sog(
        src, staging, scene_id=str(uuid.uuid4()), profile="balanced",
        gpu="cpu", source_format="ply",
    )
    assert cr.ok, f"PLY conversion failed: {cr.reason}"
    staging = cr.staging_dir or staging / cr.version_id
    assert (staging / "lod-meta.json").exists()

    # 2) Promote the staging into a published SOG asset the worker reads.
    db = SessionLocal()
    try:
        scene = _new_published_scene(db, asset_version=cr.version_id)
        version = scene.current_version
        sog_key = f"published/{scene.id}/versions/{cr.version_id}/lod-meta.json"
        from app.db.models.asset import Asset
        from app.db.models.enums import AssetKind

        db.add(
            Asset(
                scene_id=scene.id, version_id=version.id, kind=AssetKind.SOG.value,
                storage_key=sog_key, mime_type="application/json", byte_size=10,
            )
        )
        db.flush()
        dest = STORAGE / sog_key
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Copy the WHOLE streamed-SOG tree (lod-meta.json references the shard
        # files; a partial copy fails inside the real CLI).
        import shutil

        shutil.copytree(staging, dest.parent, dirs_exist_ok=True)
        assert (dest.parent / "lod-meta.json").exists()
        job, coll = _new_job_and_collision(db, scene)
        db.expire_all()

        from workers.tasks.build_collision import build_collision

        try:
            result = build_collision(
                str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
                str(version.id),
            )
        except SplatCollisionError as exc:  # pragma: no cover - surfaced
            pytest.fail(f"real CLI collision build raised: {exc}")

        assert result["ok"] is True, result
        db.expire_all()
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.id == coll.id).one()
        assert coll.status == "SUCCEEDED"
        assert coll.build_params["sourceVersion"] == cr.version_id
        # At least one real artifact was produced (voxel pair and/or glb).
        voxel_rows = [
            a for a in db.query(Asset).filter(
                Asset.scene_id == scene.id, Asset.kind == "COLLISION_VOXEL"
            ).all()
        ]
        glb_rows = [
            a for a in db.query(Asset).filter(
                Asset.scene_id == scene.id, Asset.kind == "COLLISION_GLB"
            ).all()
        ]
        assert voxel_rows or glb_rows, "no artifacts persisted"
        for row in voxel_rows + glb_rows:
            assert row.metadata_["collisionJobId"] == str(job.id)
            assert STORAGE.joinpath(row.storage_key).exists()
    finally:
        db.close()

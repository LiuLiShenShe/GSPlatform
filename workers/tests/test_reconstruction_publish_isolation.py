"""Real directories and independent DB transactions expose shared staging races."""

import hashlib
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

from app.core.config import settings
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.user import User
from app.db.session import SessionLocal
from app.services.publish_service import scene_origin_slug_dir

from workers.reconstruction import orchestrator
from workers.tasks import reconstruct_scene


def test_parallel_reconstruction_publishes_preserve_their_own_bytes(tmp_path, monkeypatch):
    root = tmp_path / "storage"
    origin = tmp_path / "origin"
    origin.mkdir()
    monkeypatch.setattr(settings, "storage_root", str(root))
    monkeypatch.setattr(settings, "scene_origin_root", str(origin))
    with SessionLocal() as session:
        owner = User(email=f"parallel-{uuid.uuid4().hex}@test.local", display_name="Parallel")
        session.add(owner)
        session.flush()
        scene = Scene(owner_id=owner.id, slug=f"parallel-{uuid.uuid4().hex}", title="Parallel",
                      category="experiment", visibility="PRIVATE", status="PROCESSING")
        session.add(scene)
        session.commit()
        scene_id = scene.id
    sentinel = root / "published" / str(scene_id) / ".staging/unrelated/keep"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"other active publication")
    expected = {}
    for index in (1, 2):
        version = f"parallel{index}"
        payload = f"independent SOG bytes for run {index}".encode()
        directory = tmp_path / version
        directory.mkdir()
        sha = hashlib.sha256(payload).hexdigest()
        manifest = {"format": "sog", "assetVersion": version,
                    "assetUrl": f"versions/{version}/scene.sog",
                    "content": {"entryUrl": f"versions/{version}/scene.sog",
                                "counts": [100 + index], "byteLength": len(payload), "sha256": sha}}
        (directory / "scene.sog").write_bytes(payload)
        (directory / "manifest.json").write_text(json.dumps(manifest))
        expected[version] = (directory, payload, manifest)
    barrier = Barrier(2)
    original_copy = orchestrator.shutil.copytree

    def synchronized_copy(source, destination, *args, **kwargs):
        result = original_copy(source, destination, *args, **kwargs)
        if source in [value[0] for value in expected.values()]:
            barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(orchestrator.shutil, "copytree", synchronized_copy)
    monkeypatch.setattr(orchestrator, "_rebuild_convert_state", lambda *_: None)
    monkeypatch.setattr(orchestrator, "_marker", lambda *a: None)

    def publish(version):
        directory, payload, manifest = expected[version]
        with SessionLocal() as session:
            context = SimpleNamespace(
                scene_id=str(scene_id), storage_root=root, session=session,
                streamed_dir=directory, version_id=version, job_id=str(uuid.uuid4()),
                convert_result=SimpleNamespace(manifest=manifest, entry_bytes=len(payload),
                                               source_sha256=hashlib.sha256(payload).hexdigest()),
                manager=SimpleNamespace(write=lambda *_: None),
            )
            orchestrator._stage_publishing(context)
            session.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(publish, expected))
    assert sentinel.read_bytes() == b"other active publication"
    with SessionLocal() as session:
        scene = session.get(Scene, scene_id)
        for version, (_, payload, manifest) in expected.items():
            directory = root / "published" / str(scene_id) / "versions" / version
            assert (directory / "scene.sog").read_bytes() == payload
            row = session.query(SceneVersion).filter_by(scene_id=scene_id, asset_version=version).one()
            assert row.manifest == manifest
            assert row.sha256 == hashlib.sha256(payload).hexdigest()
            assert (scene_origin_slug_dir(scene) / "versions" / version / "scene.sog").read_bytes() == payload
        assert (scene_origin_slug_dir(scene) / "current/scene.sog").read_bytes() in [
            value[1] for value in expected.values()
        ]


def test_finished_job_binds_its_output_even_if_another_version_is_current(monkeypatch):
    with SessionLocal() as session:
        owner = User(email=f"finish-{uuid.uuid4().hex}@test.local", display_name="Finish")
        session.add(owner)
        session.flush()
        scene = Scene(owner_id=owner.id, slug=f"finish-{uuid.uuid4().hex}", title="Finish",
                      category="experiment", visibility="PRIVATE", status="PUBLISHED")
        session.add(scene)
        session.flush()
        own_version, other_version = [
            SceneVersion(scene_id=scene.id, asset_version=uuid.uuid4().hex,
                         format="sog", size_bytes=100, manifest={})
            for _ in range(2)
        ]
        session.add_all([own_version, other_version])
        session.flush()
        scene.current_version_id = other_version.id
        job = Job(scene_id=scene.id, owner_id=owner.id, kind="RECONSTRUCT", status="RUNNING",
                  task_parameters={"algorithm": "2dgs"}, progress=90)
        session.add(job)
        session.commit()
        job_id, scene_id = str(job.id), str(scene.id)
        asset_version, own_id, other_id = own_version.asset_version, own_version.id, other_version.id

    monkeypatch.setattr(reconstruct_scene, "_run_stage_range", lambda **kwargs: {
        "ok": True, "version_id": asset_version,
    })
    assert reconstruct_scene.reconstruct_finish.run(job_id, "standard", 1, scene_id)["ok"]
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job.status == "SUCCEEDED"
        assert job.task_parameters["resultVersionId"] == str(own_id)
        assert session.get(Scene, scene_id).current_version_id == other_id

"""The model accepted by the mapping gate must be the one actually trained."""

import struct
from types import SimpleNamespace

from workers.reconstruction import orchestrator
from workers.reconstruction.profiles import load_profile


def test_mapping_promotes_largest_component_to_the_training_path(tmp_path, monkeypatch):
    root = tmp_path / "colmap/sparse"
    for name, count in [("0", 3), ("1", 246)]:
        model = root / name
        model.mkdir(parents=True)
        (model / "images.bin").write_bytes(struct.pack("<Q", count))
        (model / "cameras.bin").write_bytes(name.encode())
        (model / "points3D.bin").write_bytes(name.encode())

    def read_model(path):
        count = struct.unpack("<Q", (path / "images.bin").read_bytes())[0]
        return SimpleNamespace(path=path, registered_image_count=count, point_count=1000)

    monkeypatch.setattr(orchestrator, "_make_runner", lambda *_: None)
    monkeypatch.setattr(
        orchestrator.colmap_pipeline, "run_mapper",
        lambda *_: SimpleNamespace(ok=True, total=247),
    )
    monkeypatch.setattr(orchestrator.colmap_reader, "read_sparse_model", read_model)
    accepted = []
    monkeypatch.setattr(
        orchestrator.quality_gate, "gate_colmap_registration",
        lambda model, _: accepted.append(model.registered_image_count),
    )
    monkeypatch.setattr(orchestrator, "_marker", lambda *args: args[-1])
    markers = []
    context = SimpleNamespace(
        colmap_dir=root.parent, frames_dir=tmp_path / "frames",
        profile=load_profile("high"), frame_count=247,
        manager=SimpleNamespace(write=markers.append), job_id="full-photos",
    )
    orchestrator._stage_mapping(context)
    assert accepted == [246]
    assert read_model(root / "0").registered_image_count == 246
    assert (root / "0/cameras.bin").read_bytes() == b"1"
    assert (root / "1/images.bin").read_bytes() == (root / "0/images.bin").read_bytes()
    assert markers == ["reg=246_pts=1000"]


def test_canonical_model_is_unchanged_when_already_the_largest(tmp_path):
    root = tmp_path / "sparse"
    (root / "0").mkdir(parents=True)
    model = root / "0/images.bin"
    model.write_bytes(struct.pack("<Q", 246))
    before = model.stat().st_mtime_ns
    assert orchestrator._canonical_sparse_model(root, root / "0") == root / "0"
    assert model.stat().st_mtime_ns == before

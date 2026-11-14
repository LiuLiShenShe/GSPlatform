"""Backend selection must affect the trainer and every resumable GPU artifact."""

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch
from PIL import Image
from plyfile import PlyData, PlyElement

from workers.reconstruction import backends, orchestrator
from workers.reconstruction.colmap_reader import Camera
from workers.reconstruction.masked_training import aligned_target
from workers.reconstruction.train_2dgs_script import (
    export_editor_ply,
    latest_checkpoint,
)


@pytest.fixture
def surfel_runtime(tmp_path, monkeypatch):
    repo = tmp_path / "native"
    repo.mkdir()
    (repo / "train.py").write_text("# existing trainer")
    python = repo / "venv/bin/python"
    python.parent.mkdir(parents=True)
    python.touch()
    monkeypatch.setenv("GS_2DGS_REPO", str(repo))
    monkeypatch.setenv("GS_2DGS_PYTHON", str(python))
    return repo, python


@pytest.mark.parametrize("algorithm", ["gsplat", "2dgs"])
def test_selected_backend_dispatches_real_module_and_isolates_checkpoints(
    tmp_path, monkeypatch, surfel_runtime, algorithm
):
    job = tmp_path / "jobs/job/attempt-1"
    (job / "colmap/sparse/0").mkdir(parents=True)
    monkeypatch.setattr(orchestrator, "_tool_versions", dict)
    monkeypatch.setattr(
        orchestrator.quality_gate, "gate_training_output", lambda *a, **k: None
    )
    commands = []
    stale = job / "gsplat/checkpoints/checkpoint_100.pt"

    class Runner:
        def run(self, argv):
            commands.append(argv)
            Path(argv[argv.index("--output") + 1]).write_bytes(b"trained PLY")
            return SimpleNamespace(ok=True)

    monkeypatch.setattr(orchestrator, "_make_runner", lambda *a, **k: Runner())
    args = ("job", str(tmp_path), [], "standard", ("TRAINING", "TRAINING"))
    assert orchestrator.run_pipeline(*args, algorithm=algorithm)["ok"]
    command = commands[-1]
    expected = "train_gsplat_script" if algorithm == "gsplat" else "train_2dgs_script"
    assert command[2] == "workers.reconstruction." + expected
    if algorithm == "2dgs":
        assert command[0] == str(surfel_runtime[1])
    assert command[command.index("--iterations") + 1] == "30000"
    assert (
        json.loads((job / "gsplat/params.json").read_text())["algorithm"] == algorithm
    )
    # Identical backend and inputs reuse a finished stage.
    assert orchestrator.run_pipeline(*args, algorithm=algorithm)["ok"]
    assert len(commands) == 1
    stale.write_bytes(b"different backend checkpoint")
    other = "2dgs" if algorithm == "gsplat" else "gsplat"
    assert orchestrator.run_pipeline(*args, algorithm=other)["ok"]
    assert len(commands) == 2
    assert not stale.exists()


def test_missing_2dgs_does_not_fall_back_to_3dgs(tmp_path, monkeypatch):
    monkeypatch.setenv("GS_2DGS_REPO", str(tmp_path / "missing"))
    monkeypatch.setattr(orchestrator, "_tool_versions", dict)
    calls = []
    monkeypatch.setattr(orchestrator, "_make_runner", lambda *a, **k: calls.append(1))
    result = orchestrator.run_pipeline(
        "missing",
        str(tmp_path),
        [],
        "draft",
        ("TRAINING", "TRAINING"),
        algorithm="2dgs",
    )
    assert not result["ok"]
    assert result["error"] == "2DGS_UNAVAILABLE"
    assert not calls


def test_source_updates_invalidate_2dgs_identity(surfel_runtime):
    repo, _ = surfel_runtime
    before = backends.backend_identity("2dgs")
    (repo / "train.py").write_text("# new native trainer")
    assert before != backends.backend_identity("2dgs")


def test_native_surfel_export_preserves_coordinates_and_orientation(tmp_path):
    fields = [
        "x",
        "y",
        "z",
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "opacity",
        "scale_0",
        "scale_1",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    ]
    points = np.zeros(3, dtype=[(name, "f4") for name in fields])
    points["x"] = [1, 2, 3]
    points["rot_0"] = 1
    points["scale_0"], points["scale_1"] = -2, -3
    source, output = tmp_path / "surfel.ply", tmp_path / "editor.ply"
    PlyData([PlyElement.describe(points, "vertex")]).write(source)
    assert export_editor_ply(source, output) == 3
    converted = PlyData.read(output)["vertex"].data
    for key in fields:
        np.testing.assert_array_equal(converted[key], points[key])
    np.testing.assert_allclose(converted["scale_2"], -3 - np.log(1000), atol=1e-6)
    assert "scale_2" not in PlyData.read(source)["vertex"].data.dtype.names
    points["x"][0] = np.nan
    PlyData([PlyElement.describe(points, "vertex")]).write(source)
    with pytest.raises(ValueError, match="non-finite"):
        export_editor_ply(source, output)


def test_centered_2dgs_camera_keeps_rgb_mask_and_intrinsics_aligned(tmp_path):
    data = np.zeros((12, 16, 3), np.uint8)
    data[3:9, 3:7] = 255
    Image.fromarray(data).save(tmp_path / "rgb.png")
    Image.fromarray(data[..., 0]).save(tmp_path / "mask.png")
    camera = Camera(1, 1, 16, 12, [15, 15, 5, 4])
    rgb, mask, valid, matrix = aligned_target(
        tmp_path / "rgb.png",
        camera,
        1,
        tmp_path / "mask.png",
        center_principal_point=True,
    )
    assert float(matrix[0, 2]) == 8
    assert float(matrix[1, 2]) == 6
    assert torch.equal(rgb[..., :1] > 0.5, mask > 0.5)
    assert rgb[5, 6, 0] == 1  # Input (3, 3) shifts by the principal-point offset.
    assert float(valid.sum()) < 12 * 16


def test_checkpoint_resume_uses_highest_completed_iteration(tmp_path):
    for name in (
        "chkpnt100.pth",
        "chkpnt1000.pth",
        "chkpnt900.pth",
        "chkpnt2000.pth.tmp",
    ):
        (tmp_path / name).touch()
    assert latest_checkpoint(tmp_path).name == "chkpnt1000.pth"


@pytest.mark.parametrize(
    "stages",
    [("PROBING", "MAPPING"), ("SEGMENTING", "TRAINING"), ("CONVERTING", "SUCCEEDED")],
)
def test_every_celery_phase_reads_the_durable_algorithm(monkeypatch, stages):
    from workers.tasks import reconstruct_scene

    parameters = {
        "uploadIds": ["durable-upload"],
        "profile": "standard",
        "algorithm": "2dgs",
        "segmentation": {"mode": "KEEP_PROMPTED_OBJECT", "prompt": "plant; cube"},
    }
    monkeypatch.setattr(
        reconstruct_scene,
        "_load_job",
        lambda *_: SimpleNamespace(task_parameters=parameters),
    )
    calls = []
    monkeypatch.setattr(
        orchestrator,
        "run_pipeline",
        lambda *args, **kwargs: calls.append((args, kwargs)) or {"ok": True},
    )
    result = reconstruct_scene._run_stage_range(
        job_id="0515be0f-fd85-4d46-b0bb-c23bac4c148f",
        upload_ids=["stale-upload"],
        profile_name="draft",
        stage_range=stages,
        session=object(),
        attempt=1,
    )
    assert result["ok"]
    args, kwargs = calls[0]
    assert args[2:5] == (["durable-upload"], "standard", stages)
    assert kwargs["algorithm"] == "2dgs"
    assert kwargs["segmentation"] == parameters["segmentation"]

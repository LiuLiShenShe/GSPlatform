"""Geometry/alignment and loss-gradient contracts; real inference is separately exercised."""

import numpy as np
import torch
from PIL import Image

from workers.reconstruction.colmap_reader import Camera
from workers.reconstruction.masked_training import (
    aligned_target,
    foreground_loss,
    multiview_foreground_points,
)
from workers.reconstruction.segmentation import file_sha256, validate_manifest


def test_foreground_rgb_excludes_background_and_alpha_penalizes_it():
    rendered = torch.zeros(1, 1, 2, 3, requires_grad=True)
    alpha = torch.full((1, 1, 2, 1), 0.5, requires_grad=True)
    target = torch.ones_like(rendered)
    mask = torch.tensor([[[[1.0], [0.0]]]])
    loss, _ = foreground_loss(rendered, alpha, target, mask, torch.ones_like(mask))
    loss.backward()
    assert rendered.grad[0, 0, 0].abs().sum() > 0
    assert rendered.grad[0, 0, 1].abs().sum() == 0
    assert alpha.grad[0, 0, 0, 0] < 0
    assert alpha.grad[0, 0, 1, 0] > 0


def test_distortion_uses_the_same_map_for_mask_and_rgb(tmp_path):
    data = np.zeros((12, 16, 3), np.uint8)
    data[3:9, 5:11] = 255
    Image.fromarray(data).save(tmp_path / "rgb.png")
    Image.fromarray(data[..., 0]).save(tmp_path / "mask.png")
    camera = Camera(1, 2, 16, 12, [15, 8, 6, 0.15])
    rgb, mask, valid, intrinsic = aligned_target(
        tmp_path / "rgb.png", camera, 2, tmp_path / "mask.png"
    )
    assert rgb.shape == (6, 8, 3)
    assert mask.shape == valid.shape == (6, 8, 1)
    assert torch.equal(rgb[..., :1] > 0.5, mask > 0.5)
    assert intrinsic[0, 0] == 7.5


def test_filter_rejects_background_and_requires_multiple_observations():
    mask = torch.zeros(10, 10, 1)
    mask[3:7, 3:7] = 1
    view = {
        "viewmat": torch.eye(4),
        "K": torch.tensor([[5.0, 0, 5], [0, 5, 5], [0, 0, 1]]),
    }
    xyz = np.array([[0, 0, 2], [1.6, 0, 2], [0, 0, -1]])
    assert multiview_foreground_points(xyz, [view, view], [mask, mask]).tolist() == [
        True,
        False,
        False,
    ]
    assert not multiview_foreground_points(xyz, [view], [mask]).any()


def test_mask_identity_rejects_same_size_substitution(tmp_path):
    import json

    import pytest

    images = tmp_path / "images"
    masks = tmp_path / "seg/masks"
    images.mkdir()
    masks.mkdir(parents=True)
    Image.new("RGB", (10, 10)).save(images / "a.png")
    Image.new("L", (10, 10), 255).save(masks / "a.png.png")
    frame = {
        "name": "a.png",
        "size": [10, 10],
        "foregroundPixels": 100,
        "imageSha256": file_sha256(images / "a.png"),
        "maskSha256": file_sha256(masks / "a.png.png"),
    }
    (masks.parent / "manifest.json").write_text(json.dumps({"frames": [frame]}))
    validate_manifest(masks.parent, images, minimum_views=1)
    Image.new("L", (10, 10), 0).save(masks / "a.png.png")
    with pytest.raises(ValueError, match="掩膜已变化"):
        validate_manifest(masks.parent, images, minimum_views=1)


def test_resume_after_inference_crash_reuses_only_exact_verified_manifest(
    tmp_path, monkeypatch
):
    import json

    from workers.reconstruction import orchestrator, segmentation

    root = tmp_path / "jobs" / "resume" / "attempt-1"
    images = root / "frames"
    directory = root / "segmentation"
    masks = directory / "masks"
    images.mkdir(parents=True)
    masks.mkdir(parents=True)
    frames = []
    for index in range(3):
        name = f"{index}.png"
        Image.new("RGB", (10, 10), "green").save(images / name)
        Image.new("L", (10, 10), 255).save(masks / (name + ".png"))
        frames.append(
            {
                "name": name,
                "size": [10, 10],
                "foregroundPixels": 100,
                "imageSha256": file_sha256(images / name),
                "maskSha256": file_sha256(masks / (name + ".png")),
            }
        )
    identity = {"commit": "official-test-identity", "checkpointSha256": "a" * 64}
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "model": identity,
                "prompt": "plant",
                "frames": frames,
            }
        )
    )
    calls = []
    monkeypatch.setattr(
        segmentation, "runtime_identity", lambda: calls.append(1) or identity
    )
    monkeypatch.setattr(orchestrator, "_tool_versions", lambda: {})

    def forbidden_runner(*args, **kwargs):
        raise AssertionError("completed, verified inference must not load SAM3 again")

    monkeypatch.setattr(orchestrator, "_make_runner", forbidden_runner)
    arguments = ("resume", str(tmp_path), [], "draft", ("SEGMENTING", "SEGMENTING"))
    settings = {"mode": "KEEP_PROMPTED_OBJECT", "prompt": "plant"}
    assert orchestrator.run_pipeline(*arguments, segmentation=settings)["ok"]
    assert len(calls) == 1  # Same identity for checking and writing the marker.
    assert orchestrator.run_pipeline(*arguments, segmentation=settings)["ok"]
    changed = {**settings, "prompt": "another object"}
    assert not orchestrator.run_pipeline(*arguments, segmentation=changed)["ok"]

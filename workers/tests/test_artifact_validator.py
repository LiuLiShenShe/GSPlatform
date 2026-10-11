from __future__ import annotations

import io
import json
import zipfile

from workers.pipeline.convert_scene import convert_to_streamed_sog


def test_invalid_streamed_zip_is_rejected_not_reconverted(tmp_path):
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("lod-meta.json", json.dumps({
            "counts": [30, 20, 10], "filenames": ["../outside/meta.json"], "tree": {},
        }))
    source = tmp_path / "upload.bin"
    source.write_bytes(payload.getvalue())
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="test",
                                     source_format="zip")
    assert not result.ok
    assert "验证失败" in result.reason


def test_empty_streamed_zip_is_not_a_publishable_scene(tmp_path):
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("lod-meta.json", json.dumps({
            "counts": [30, 20, 10], "filenames": [], "tree": {},
        }))
    source = tmp_path / "upload.bin"
    source.write_bytes(payload.getvalue())
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="test",
                                     source_format="sog")
    assert not result.ok
